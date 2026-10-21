import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import studioMetrics from '../runtime/studio-metrics-extension.mjs';
import { createMetrics } from '../lib/metrics.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-code-signals-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
function harness(t, directory) {
  const old = process.env.PRIME_STUDIO_METRICS_DIR;
  process.env.PRIME_STUDIO_METRICS_DIR = directory;
  t.after(() => {
    if (old === undefined) delete process.env.PRIME_STUDIO_METRICS_DIR;
    else process.env.PRIME_STUDIO_METRICS_DIR = old;
  });
  const handlers = new Map();
  studioMetrics({ on: (name, handler) => handlers.set(name, handler) });
  const ctx = {
    cwd: '/fixture/project',
    model: { provider: 'fixture', id: 'model' },
    sessionManager: { getSessionId: () => 'session-one', getHeader: () => ({}) },
  };
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  return { emit };
}
const searchResult = (paths) => ({
  content: [{ type: 'text', text: JSON.stringify({ results: paths.map((path) => ({ path, text: 'const x = 1;' })) }) }],
});
async function rows(root) {
  const names = await readdir(root);
  assert.equal(names.length, 1);
  const raw = await readFile(join(root, names[0]), 'utf8');
  assert.doesNotMatch(raw, /src\/returned/);
  return raw.trim().split('\n').map(JSON.parse);
}

test('a returned file opened within five calls marks the search useful', async (t) => {
  const root = await temporary(t);
  const { emit } = harness(t, root);
  emit('tool_execution_end', { toolName: 'studio_code_search', args: { q: 'helper' }, result: searchResult(['src/returned.js']), isError: false });
  emit('tool_execution_end', { toolName: 'unrelated', args: {}, isError: false });
  emit('tool_execution_end', { toolName: 'read', args: { path: 'src/returned.js' }, isError: false });
  await emit('session_shutdown');
  const row = (await rows(root)).find((entry) => entry.tool);
  assert.equal(row.tool, 'search');
  assert.equal(row.hits, 1);
  assert.equal(row.files, 1);
  assert.ok(row.chars > 0);
  assert.equal(row.useful, true);
  assert.equal(row.fallback, false);
});

test('a shell grep within three calls marks the lookup as fallback', async (t) => {
  const root = await temporary(t);
  const { emit } = harness(t, root);
  emit('tool_execution_end', { toolName: 'studio_code_symbols', args: { symbol: 'helper' }, result: searchResult(['src/other.js']), isError: false });
  emit('tool_execution_end', { toolName: 'shell', args: { command: 'grep -rn helper src' }, isError: false });
  await emit('session_shutdown');
  const row = (await rows(root)).find((entry) => entry.tool);
  assert.equal(row.tool, 'symbols');
  assert.equal(row.useful, false);
  assert.equal(row.fallback, true);
});

test('tool calls until the next edit are recorded', async (t) => {
  const root = await temporary(t);
  const { emit } = harness(t, root);
  emit('tool_execution_end', { toolName: 'studio_code_map', args: { path: 'src' }, result: searchResult(['src/a.js', 'src/b.js']), isError: false });
  emit('tool_execution_end', { toolName: 'read', args: { path: 'notes.txt' }, isError: false });
  emit('tool_execution_end', { toolName: 'edit', args: { path: 'src/a.js' }, isError: false });
  await emit('session_shutdown');
  const row = (await rows(root)).find((entry) => entry.tool);
  assert.equal(row.tool, 'map');
  assert.equal(row.hits, 2);
  assert.equal(row.files, 2);
  assert.equal(row.callsToEdit, 2);
});

test('ledger aggregates per-tool usefulness without changing existing metrics', async (t) => {
  const root = await temporary(t);
  const dataDir = join(root, 'data'), sessionDir = join(root, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const base = { ts: Date.now(), sessionId: 's', project: '/fixture/project', provider: 'fixture', model: 'model' };
  await writeFile(join(dataDir, 'metrics', `${day}.jsonl`), jsonl([
    { ...base, id: 't1', type: 'tool_execution_end', toolCalls: 1, tool: 'search', hits: 3, files: 2, chars: 40, useful: true, fallback: false, callsToEdit: 1 },
    { ...base, id: 't2', type: 'tool_execution_end', toolCalls: 1, tool: 'search', hits: 1, files: 1, chars: 10, useful: false, fallback: true, callsToEdit: null },
    { ...base, id: 't3', type: 'tool_execution_end', toolCalls: 1 },
  ]), { flag: 'w' }).catch(async () => {
    await mkdir(join(dataDir, 'metrics'), { recursive: true });
    await writeFile(join(dataDir, 'metrics', `${day}.jsonl`), jsonl([
      { ...base, id: 't1', type: 'tool_execution_end', toolCalls: 1, tool: 'search', hits: 3, files: 2, chars: 40, useful: true, fallback: false, callsToEdit: 1 },
      { ...base, id: 't2', type: 'tool_execution_end', toolCalls: 1, tool: 'search', hits: 1, files: 1, chars: 10, useful: false, fallback: true, callsToEdit: null },
      { ...base, id: 't3', type: 'tool_execution_end', toolCalls: 1 },
    ]));
  });
  const metrics = createMetrics({ dataDir, sessionDir });
  try {
    await metrics.refresh();
    const summary = await metrics.summary();
    assert.equal(summary.totals.toolCalls, 3);
    assert.deepEqual(summary.totals.codeTools.search, { calls: 2, useful: 1, fallback: 1 });
    assert.deepEqual(summary.totals.codeTools.symbols, { calls: 0, useful: 0, fallback: 0 });
    assert.deepEqual(summary.totals.codeTools.map, { calls: 0, useful: 0, fallback: 0 });
  } finally {
    await metrics.close();
  }
});
