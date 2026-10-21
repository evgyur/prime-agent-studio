import { readFile, writeFile, mkdir, rename, rm, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, matchesGlob } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodeIndex } from './code-index.mjs';
import { sensitiveCodePath } from './code-context-policy.mjs';
import { metricsProjectId } from './metrics.mjs';
import { HttpError, validId } from './store.mjs';

const bad = (message) => { throw new HttpError(400, message); };
const secret = sensitiveCodePath;
function relativePath(value, pattern = false) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\x00-\x1f\\:]/.test(value) || isAbsolute(value) || value.split('/').some((p) => p === '..' || p === '.')) bad('Use a project-relative path.');
  if (!pattern && /[*?\[\]]/.test(value)) bad('Use a file path, not a pattern.');
  return value.replace(/\/+$/, '');
}
function excluded(path, exclusions) {
  return exclusions.some((pattern) => matchesGlob(path, pattern) || path === pattern || path.startsWith(pattern + '/'));
}

export function createContextService({ dataDir, store, index: suppliedIndex }) {
  const clients = new Map();
  const notifications = new Map();
  const pending = new Map();
  const jobs = new Map();
  let closed = false;
  const index = suppliedIndex || createCodeIndex({ dataDir, onUpdate: (project) => { void notify(typeof project === 'string' ? project : project?.id || project?.metricsId); } });
  const folder = (id) => join(dataDir, 'code-index', id);
  async function storageSafe(cwd) {
    const root = await realpath(cwd);
    const base = await realpath(dataDir).catch(() => resolve(dataDir));
    const rel = relative(root, base);
    if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw new HttpError(409, 'Context data must be outside the project.');
    for (const path of [join(base, 'code-index'), folder(metricsProjectId(cwd))]) {
      const info = await lstat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info?.isSymbolicLink()) throw new HttpError(409, 'Context storage cannot use symbolic links.');
    }
  }
  async function project(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new HttpError(404, 'Unknown project.');
    const found = (await store.overview()).projects.find((p) => metricsProjectId(p.cwd) === id);
    if (!found) throw new HttpError(404, 'Unknown project.');
    await storageSafe(found.cwd);
    return { ...found, id, metricsId: id, path: found.cwd };
  }
  function session(project, id) {
    if (!id) return;
    if (!validId(id) || !project.sessions?.some((s) => s.id === id)) throw new HttpError(404, 'Unknown project session.');
  }
  async function settings(id) {
    try {
      const config = { enabled: false, includeGenerated: false, exclusions: [], sessions: {}, ...JSON.parse(await readFile(join(folder(id), 'settings.json'), 'utf8')) };
      delete config.pins; // Legacy pin snapshots are ignored.
      return config;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { enabled: false, includeGenerated: false, exclusions: [], sessions: {} };
    }
  }
  async function get(id, sessionId) {
    const p = await project(id);
    session(p, sessionId);
    const config = await settings(id);
    return { enabled: config.enabled, includeGenerated: config.includeGenerated === true, sessionEnabled: config.sessions[sessionId] !== false, exclusions: config.exclusions, index: config.enabled ? await index.status(p, { exclusions: config.exclusions }) : { state: 'disabled', files: 0, symbols: 0, updatedAt: null } };
  }
  async function notify(id) {
    if (closed || !id || !clients.has(id)) return;
    const task = (notifications.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      if (closed || !clients.has(id)) return;
      await Promise.all([...clients.get(id)].map(async ({ res, sessionId }) => {
        try { const state = await get(id, sessionId); if (!res.destroyed) res.write('event: context\ndata: ' + JSON.stringify(state) + '\n\n'); }
        catch { /* Project/session may have been removed. */ }
      }));
    });
    notifications.set(id, task);
    try { await task; } finally { if (notifications.get(id) === task) notifications.delete(id); }
  }

  function schedule(p, config, rebuild = false) {
    if (closed || !config.enabled) return;
    // Serialize refreshes per project; index owns filesystem watching and debounce.
    const job = (jobs.get(p.id) || Promise.resolve()).catch(() => {}).then(async () => {
      if (closed) return;
      const latest = await settings(p.id);
      if (!latest.enabled) return;
      await storageSafe(p.path);
      await index.ensureProject(p, { exclusions: latest.exclusions, includeGenerated: latest.includeGenerated === true });
      if (closed || !(await settings(p.id)).enabled) { await index.stopProject?.(p); return; }
      await index.refresh(p, { rebuild, exclusions: latest.exclusions, includeGenerated: latest.includeGenerated === true });
      await notify(p.id);
    }).catch(() => {});
    jobs.set(p.id, job);
    void job.finally(() => { if (jobs.get(p.id) === job) jobs.delete(p.id); });
  }
  async function ensureAll() {
    for (const p of (await store.overview()).projects) {
      if (closed) break;
      const id = metricsProjectId(p.cwd);
      schedule({ ...p, id, metricsId: id, path: p.cwd }, await settings(id));
      // Startup runs in the background; finish each scan before admitting another worker.
      await jobs.get(id);
    }
  }
  async function patch(id, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !['enabled', 'includeGenerated', 'sessionEnabled', 'sessionId', 'exclusions'].includes(k))) bad('Invalid context settings.');
    const work = (pending.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const p = await project(id);
      session(p, body.sessionId);
      const config = await settings(id);
      for (const key of ['enabled', 'includeGenerated', 'sessionEnabled']) if (key in body && typeof body[key] !== 'boolean') bad('Context switches must be boolean.');
      if ('sessionEnabled' in body && !body.sessionId) bad('Select a session first.');
      if ('exclusions' in body) {
        if (!Array.isArray(body.exclusions) || body.exclusions.length > 100) bad('Too many exclusions.');
        config.exclusions = [...new Set(body.exclusions.map((p) => relativePath(p, true)))];
      }
      if ('enabled' in body) config.enabled = body.enabled;
      if ('includeGenerated' in body) config.includeGenerated = body.includeGenerated;
      if ('sessionEnabled' in body) config.sessions[body.sessionId] = body.sessionEnabled;
      await mkdir(folder(id), { recursive: true });
      const temp = join(folder(id), 'settings-' + randomUUID() + '.tmp');
      await writeFile(temp, JSON.stringify(config) + '\n', { mode: 0o600 });
      await rename(temp, join(folder(id), 'settings.json'));
      if (!config.enabled) await index.stopProject?.(p);
      schedule(p, config);
      await notify(id);
      return get(id, body.sessionId);
    });
    pending.set(id, work);
    try { return await work; } finally { if (pending.get(id) === work) pending.delete(id); }
  }
  return {
    get, patch, ensureAll, notify,
    async runtimeConfig(cwd, sessionId) {
      const id = metricsProjectId(cwd);
      const config = await settings(id);
      const safe = await storageSafe(cwd).then(() => true, () => false);
      const enabled = safe && config.enabled && config.sessions[sessionId] !== false;
      if (enabled && !closed) {
        const p = { id, metricsId: id, path: cwd };
        const status = await index.status(p).catch(() => ({ state: 'error' }));
        // Read-only native tools cannot restart a writer evicted from the LRU.
        // Re-admit it in the background; starting a conversation never waits for a scan.
        if (['not-ready', 'error'].includes(status.state) && !jobs.has(id)) schedule(p, config);
      }
      return { dataDir, projectId: id, projectPath: cwd, sessionId, exclusions: config.exclusions, includeGenerated: config.includeGenerated === true, enabled, sessionEnabled: config.sessions[sessionId] !== false };
    },
    async rebuild(id) {
      const p = await project(id), config = await settings(id);
      if (!config.enabled) throw new HttpError(409, 'Enable project context before rebuilding.');
      schedule(p, config, true);
      return { queued: true };
    },
    async search(id, body) {
      const p = await project(id), config = await settings(id);
      if (typeof body.q !== 'string' || !body.q.trim() || body.q.length > 500 || (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50))) bad('Invalid context search.');
      if (!config.enabled) return { state: 'disabled', results: [] };
      const result = await index.search(p, { q: body.q, limit: body.limit || 20, exclusions: config.exclusions, includeGenerated: config.includeGenerated === true });
      return { ...result, results: (result.results || []).filter((row) => typeof row.path === 'string' && !secret(row.path) && !excluded(row.path, config.exclusions)) };
    },
    async events(id, sessionId, req, res) {
      const initial = await get(id, sessionId);
      if (closed || res.destroyed) return;
      // Legacy dossier snapshot files are removed on read; nothing watches them.
      await rm(join(folder(id), 'sessions'), { recursive: true, force: true }).catch(() => {});
      if (closed || res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('event: context\ndata: ' + JSON.stringify(initial) + '\n\n');
      const client = { res, sessionId };
      if (!clients.has(id)) clients.set(id, new Set());
      clients.get(id).add(client);
      res.once('close', () => { clients.get(id)?.delete(client); if (!clients.get(id)?.size) clients.delete(id); });
    },
    async close() {
      closed = true;
      for (const group of clients.values()) for (const { res } of group) res.end();
      clients.clear();
      await index.close();
      await Promise.allSettled([...pending.values(), ...jobs.values()]);
    },
  };
}
