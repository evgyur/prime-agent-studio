import { createCodeIndex } from '../lib/code-index.mjs';
import { sensitiveCodePath } from '../lib/code-context-policy.mjs';
import { realpath, readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';

const inside = (root, path) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const safePath = (path) => typeof path === 'string' && path.length <= 500 && !isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..') && !sensitiveCodePath(path);
const excluded = (path, exclusions) => exclusions.some((pattern) => matchesGlob(path, pattern) || path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`));
export async function dispatchCode({ config, action, params = {} }) {
  if (!config?.enabled || config.sessionEnabled === false || !config.dataDir || !config.projectPath || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.projectId)) throw new Error('Code context is disabled or invalid.');
  if (!['search', 'symbols', 'map'].includes(action)) throw new Error('Unknown code operation.');
  const projectRoot = await realpath(config.projectPath);
  const dataRoot = await realpath(config.dataDir);
  if (inside(projectRoot, dataRoot)) throw new Error('Code data must be outside the project.');
  const settingsPath = join(dataRoot, 'code-index', config.projectId, 'settings.json');
  try {
    const settingsFile = await realpath(settingsPath);
    if (!inside(dataRoot, settingsFile)) throw new Error('Unsafe code settings file.');
    const latest = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (latest.enabled === false || latest.sessions?.[config.sessionId] === false) return { state: 'disabled', results: [] };
    config = { ...config, exclusions: latest.exclusions || [], includeGenerated: latest.includeGenerated === true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const exclusions = (Array.isArray(config.exclusions) ? config.exclusions : []).filter((item) => typeof item === 'string').slice(0, 100);
  const project = { id: config.projectId, metricsId: config.projectId, path: projectRoot };
  const reader = createCodeIndex({ dataDir: dataRoot, readOnly: true });
  const index = Object.fromEntries(['search', 'symbols', 'map'].map((method) => [method, async (target, options) => {
    const result = await reader[method](target, { includeGenerated: config.includeGenerated === true, ...options, exclusions });
    return { ...result, results: (result.results || []).filter((row) => safePath(row.path) && !excluded(row.path, exclusions)).map((row) =>
      row.coChanges ? { ...row, coChanges: row.coChanges.filter((item) => safePath(item.path) && !excluded(item.path, exclusions)) } : row) };
  }]));
  try {
    return await index[action](project, { ...params, limit: Math.min(20, Math.max(1, Number(params.limit) || 8)) });
  } finally { await reader.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input = '';
  try {
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 128 * 1024) throw new Error('Code request too large.'); }
    process.stdout.write(JSON.stringify(await dispatchCode(JSON.parse(input))));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
