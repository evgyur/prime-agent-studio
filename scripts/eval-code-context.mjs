// Offline relevance evaluation. Indexes live source into OS TEMP; never writes the target project.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createCodeIndex } from '../lib/code-index.mjs';
import { buildDossier } from './studio-code-worker.mjs';

const lockfile = (path) => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i.test(path);
const noise = (path) => lockfile(path) || /(?:^|\/)(?:README[^/]*|translations\.[^/]+)$|(?:^|\/)(?:i18n|locales|translations)\//i.test(path);
export function scoreResults(rows, expected) {
  const paths = rows.map((row) => row.path);
  const recall = (n) => expected.filter((path) => paths.slice(0, n).includes(path)).length / Math.max(1, expected.length);
  const rank = paths.findIndex((path) => expected.includes(path));
  return { recall1: recall(1), recall5: recall(5), mrr: rank < 0 ? 0 : 1 / (rank + 1),
    duplicates: paths.length - new Set(paths).size,
    noiseShare: paths.filter(noise).length / Math.max(1, paths.length),
    lockShare: paths.filter(lockfile).length / Math.max(1, paths.length),
    i18nShare: paths.filter((path) => /(?:^|\/)(?:i18n|locales|translations)\/|(?:^|\/)translations\.[^/]+$/i.test(path)).length / Math.max(1, paths.length),
    readmeShare: paths.filter((path) => /(?:^|\/)README[^/]*$/i.test(path)).length / Math.max(1, paths.length),
    chars: JSON.stringify(rows).length };
}

async function implementationDigests() {
  const hashes = {};
  for (const path of ['../lib/code-index.mjs', '../lib/code-index-worker.mjs', '../lib/code-context-policy.mjs', './studio-code-worker.mjs']) {
    try { hashes[path] = createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hashes[path] = null; }
  }
  return hashes;
}

export async function evaluate(projectPath, cases) {
  const implementationStart = await implementationDigests();
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-context-eval-'));
  const project = { path: resolve(projectPath) };
  const index = createCodeIndex({ dataDir });
  try {
    const status = await index.refresh(project);
    if (status.state !== 'ready') throw new Error(JSON.stringify(status));
    const results = [];
    for (const item of cases) {
      const start = performance.now();
      const response = item.action === 'dossier'
        ? await buildDossier({ sessionId: 'offline-eval', ...item.config }, item.params, index, project)
        : await index[item.action](project, { limit: 5, ...item.params });
      if (response.error) throw new Error(`${item.id}: ${response.error}`);
      results.push({ id: item.id, action: item.action, params: item.params, expected: item.expected,
        elapsedMs: performance.now() - start, response });
    }
    const implementationEnd = await implementationDigests();
    return rescoreReport({ project: project.path, createdAt: new Date().toISOString(), status, results,
      implementationStart, implementationEnd, changedDuringEvaluation: JSON.stringify(implementationStart) !== JSON.stringify(implementationEnd) });
  } finally { await index.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}


export function rescoreReport(report, expectations = {}) {
  const results = report.results.map((item) => {
    const response = item.response;
    const rows = item.action === 'dossier'
      ? [...response.text.matchAll(/^Relevant: (.+?):(\d+)-(\d+)/gm)].map((m) => ({ path: m[1] }))
      : response.results || [];
    const expected = expectations[item.id] || {};
    const matches = (row, wanted) => row.path === wanted.path && row.name === wanted.name && row.line === wanted.line && row.kind === 'definition';
    const mapped = rows.flatMap((row) => (row.definitions || []).map((definition) => ({ ...definition, path: row.path })));
    return { ...item, expectations: expected, metrics: { ...scoreResults(rows, item.expected), chars: JSON.stringify(response).length,
      expectedHits: item.expected.filter((path) => rows.some((row) => row.path === path)).length,
      definitionHits: rows.filter((row) => row.kind === 'definition' && item.expected.includes(row.path)).length,
      declarationHits: (expected.declarations || []).filter((wanted) => rows.some((row) => matches(row, wanted))).length,
      expectedDeclarations: expected.declarations?.length || 0,
      mapMethodHits: (expected.methods || []).filter((wanted) => mapped.some((row) => matches(row, wanted))).length,
      mapExpectedMethods: expected.methods?.length || 0,
    } };
  });
  const aggregate = {};
  for (const action of ['all', 'search', 'symbols', 'map', 'dossier']) {
    const selected = results.filter((row) => action === 'all' || row.action === action);
    if (!selected.length) continue;
    aggregate[action] = { count: selected.length, totalChars: selected.reduce((sum, row) => sum + row.metrics.chars, 0),
      ...Object.fromEntries(Object.keys(selected[0].metrics).map((key) => [key, selected.reduce((sum, row) => sum + row.metrics[key], 0) / selected.length])) };
  }
  return { ...report, results, aggregate };
}

export async function mapAcceptance(projectPath, paths) {
  const implementationStart = await implementationDigests();
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-context-eval-acceptance-'));
  const index = createCodeIndex({ dataDir }), project = { path: resolve(projectPath) };
  try {
    const status = await index.refresh(project);
    if (status.state !== 'ready') throw new Error(JSON.stringify(status));
    const results = [];
    for (const path of paths) {
      const response = await index.map(project, { path, limit: 1 });
      results.push({ path, indexed: (response.results || []).some((row) => row.path === path), response });
    }
    const implementationEnd = await implementationDigests();
    return { project: project.path, status, results, implementationStart, implementationEnd, changedDuringEvaluation: JSON.stringify(implementationStart) !== JSON.stringify(implementationEnd) };
  } finally { await index.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

export async function conductorCoverage(projectPath, indexModule = new URL('../lib/code-index.mjs', import.meta.url).href) {
  const implementationStart = await implementationDigests();
  const path = 'src/state/conductor.ts';
  const source = await readFile(join(projectPath, path), 'utf8');
  const classStart = source.indexOf('export class Conductor');
  if (classStart < 0) throw new Error('Conductor class not found');
  const lines = source.split('\n');
  const classLine = source.slice(0, classStart).split('\n').length - 1;
  const declarations = lines.flatMap((line, i) => {
    const match = /^  (?:(?:private|public|protected|async|static|override)\s+)*([A-Za-z_$][\w$]*)\(/.exec(line);
    return match && match[1] !== 'constructor' && i > classLine
      ? [{ name: match[1], line: i + 1, path }] : [];
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-context-eval-coverage-'));
  const { createCodeIndex: create } = await import(indexModule);
  const index = create({ dataDir }), project = { path: resolve(projectPath) };
  try {
    const status = await index.refresh(project);
    if (status.state !== 'ready') throw new Error(JSON.stringify(status));
    const results = [];
    for (const declaration of declarations) {
      const response = await index.symbols(project, { symbol: declaration.name, limit: 20 });
      results.push({ ...declaration, hit: (response.results || []).some((row) => row.path === path && row.name === declaration.name && row.line === declaration.line && row.kind === 'definition'), response });
    }
    const implementationEnd = await implementationDigests();
    return { implementationStart, implementationEnd, changedDuringEvaluation: JSON.stringify(implementationStart) !== JSON.stringify(implementationEnd), project: project.path, sourceSha256: createHash('sha256').update(source).digest('hex'), expected: declarations.length,
      hits: results.filter((row) => row.hit).length, results };
  } finally { await index.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, arg1, arg2, arg3] = process.argv.slice(2);
  if (mode === '--rescore') {
    const report = rescoreReport(JSON.parse(await readFile(arg1, 'utf8')), JSON.parse(await readFile(arg2, 'utf8')));
    await writeFile(arg3, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.aggregate, null, 2));
  } else if (mode === '--acceptance') {
    const paths = JSON.parse(await readFile(arg2, 'utf8'));
    const report = await mapAcceptance(arg1, paths);
    await writeFile(arg3, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.results.map(({ path, indexed }) => ({ path, indexed }))));
  } else if (mode === '--coverage') {
    const report = await conductorCoverage(arg1, arg3 ? pathToFileURL(resolve(arg3)).href : undefined);
    await writeFile(arg2, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ expected: report.expected, hits: report.hits }));
  } else {
    const [casesPath, projectPath, outputPath] = [mode, arg1, arg2];
    if (!casesPath || !projectPath || !outputPath) throw new Error('Usage: node scripts/eval-code-context.mjs cases.json project output.json');
    const casesText = await readFile(casesPath, 'utf8');
    const report = rescoreReport(await evaluate(projectPath, JSON.parse(casesText)));
    report.casesSha256 = createHash('sha256').update(casesText).digest('hex');
    if (report.changedDuringEvaluation) process.exitCode = 2;
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.aggregate, null, 2));
  }
}
