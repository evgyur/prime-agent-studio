import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createStore } from '../lib/store.mjs';
import { createSessionInspector } from '../lib/session-inspector.mjs';

async function fixture(t, { children = 2, liveChildren = [], artifacts = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-metrics-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = join(dir, 'project'),
    sessionDir = join(dir, 'sessions'),
    agentHome = join(dir, 'agent');
  await mkdir(cwd);
  await mkdir(sessionDir);
  await mkdir(agentHome);
  const own = { input: 10, output: 5, cacheRead: 80, cacheWrite: 10, cost: { total: 0.01 } };
  const edges = [];
  const files = [];
  const artifactDir = join(agentHome, 'session-artifacts', 'agent-0', 'child');
  if (artifacts) await mkdir(artifactDir, { recursive: true });
  for (let i = 0; i <= children; i++) {
    const id = `agent-${i}`,
      file = join(artifacts && i ? artifactDir : sessionDir, `${id}.jsonl`);
    files.push(file);
    const records = [
      { type: 'session', id, cwd, version: 3, timestamp: '2026-10-01T00:00:00Z' },
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Fixture' } },
      { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [], usage: own } },
    ];
    await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
    if (i) edges.push({ parent: files[i - 1], child: file, childId: id });
  }
  const store = createStore({ initialCwd: cwd, sessionDir, dataDir: join(dir, 'data') });
  let reads = 0;
  const inspector = createSessionInspector({
    store: {
      ...store,
      inspectFile: async (file) => {
        reads++;
        return store.inspectFile(file);
      },
    },
    agentHome,
    sessionDir,
    readEdges: async () => edges,
    getRun: () => ({ status: 'running' }),
    getClient: () => ({ getInspector: async () => ({ state: {}, children: liveChildren }), close() {} }),
  });
  return { dir, agentHome, sessionDir, own, inspector, store, cwd, edges, files, reads: () => reads };
}

test('cache split and weighted ratio include nested descendants, retain main and last request', async (t) => {
  const f = await fixture(t);
  const data = await f.inspector.inspect(f.cwd, 'agent-0');
  assert.deepEqual(data.session.usage, {
    input: 10,
    output: 5,
    cacheRead: 80,
    cacheWrite: 10,
    cache: 90,
    cost: 0.01,
    cacheHitRatio: 0.8,
  });
  assert.equal(data.session.subagentCount, 2);
  assert.equal(data.session.totalUsage.input, 30);
  assert.equal(data.session.totalUsage.cacheRead, 240);
  assert.equal(data.session.totalUsage.cacheWrite, 30);
  assert.equal(data.session.totalUsage.cacheHitRatio, 0.8);
  assert.equal(data.session.totalUsage.cost, 0.03);
  assert.deepEqual(data.session.lastRequestUsage, data.session.usage);
  assert.equal(data.session.usageIncomplete, false);
  await f.inspector.inspect(f.cwd, 'agent-0');
  assert.equal(f.reads(), 2, 'snapshot reuse does not reread children');
  const first = await f.store.inspectFile(f.files[1]);
  assert.equal(await f.store.inspectFile(f.files[1]), first, 'unchanged size/mtime reuses parsed history');
  await appendFile(f.files[1], '\n');
  assert.notEqual(await f.store.inspectFile(f.files[1]), first, 'file growth invalidates the history cache');
});

test('artifact history cache survives expired inspector snapshots and still detects changes', async (t) => {
  const f = await fixture(t, { children: 1, artifacts: true });
  await f.inspector.inspect(f.cwd, 'agent-0');
  const first = await f.store.inspectFile(f.files[1]);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 2001);
  await f.inspector.inspect(f.cwd, 'agent-0');
  assert.equal(f.reads(), 2, 'expired snapshot re-inspects its artifact child');
  assert.equal(await f.store.inspectFile(f.files[1]), first, 'unchanged artifact is not reparsed');
  await appendFile(f.files[1], '\n');
  assert.notEqual(await f.store.inspectFile(f.files[1]), first, 'changed artifact is reparsed');
});

test('native child attributions retain aggregate but own totals and last request never double count', async (t) => {
  const f = await fixture(t);
  const double = { input: 20, output: 10, cacheRead: 160, cacheWrite: 20, cost: { total: 0.02 } };
  const triple = { input: 30, output: 15, cacheRead: 240, cacheWrite: 30, cost: { total: 0.03 } };
  await appendFile(
    f.files[0],
    JSON.stringify({
      type: 'child_usage_attributed',
      id: 'attr',
      parentId: 'a',
      targetId: 'a',
      childUsage: double,
      aggregateUsage: triple,
    }) + '\n',
  );
  await appendFile(
    f.files[1],
    JSON.stringify({
      type: 'child_usage_attributed',
      id: 'attr',
      parentId: 'a',
      targetId: 'a',
      childUsage: f.own,
      aggregateUsage: double,
    }) + '\n',
  );
  const history = await f.store.history('agent-0');
  assert.equal(history.messages.at(-1).usage.input, 30);
  assert.equal(history.messages.at(-1).ownUsage.input, 10);
  const { session } = await f.inspector.inspect(f.cwd, 'agent-0');
  assert.equal(session.usage.input, 10);
  assert.equal(session.totalUsage.input, 30);
  assert.equal(session.lastRequestUsage.cacheRead, 80);
  assert.ok(Math.abs(session.totalUsage.cost - 0.03) < 1e-10);
});

test('zero denominator and missing costs stay unknown; live children mark partial rollups', async (t) => {
  const f = await fixture(t, { children: 0, liveChildren: [{ id: 'live-child', status: 'running' }] });
  await appendFile(
    f.files[0],
    JSON.stringify({
      type: 'message',
      id: 'zero',
      parentId: 'a',
      message: { role: 'assistant', content: [], usage: { input: 0, output: 0 } },
    }) + '\n',
  );
  const { session } = await f.inspector.inspect(f.cwd, 'agent-0');
  assert.equal(session.usage.cost, null);
  assert.equal(session.totalUsage.cost, null);
  assert.equal(session.lastRequestUsage.cacheHitRatio, null);
  assert.equal(session.usageIncomplete, true);
});

test('hierarchy is bounded at 200 descendants, including live-only agents', async (t) => {
  const f = await fixture(t, {
    children: 0,
    liveChildren: Array.from({ length: 250 }, (_, i) => ({ id: `live-${i}` })),
  });
  const data = await f.inspector.inspect(f.cwd, 'agent-0');
  assert.equal(data.agents.length, 201);
  assert.equal(data.session.subagentCount, 200);
  assert.equal(data.truncated, true);
  assert.equal(data.session.usageIncomplete, true);
});

test('oversized child histories are not read and totals declare their limit', async (t) => {
  const f = await fixture(t, { children: 1 });
  await appendFile(f.files[1], ' '.repeat(16 * 1024 * 1024));
  const { session } = await f.inspector.inspect(f.cwd, 'agent-0');
  assert.equal(f.reads(), 0);
  assert.equal(session.subagentCount, 0);
  assert.equal(session.usageIncomplete, true);
});

test('cumulative overlays 100 + 50 + 30 yield main 100 and descendant total 180', async (t) => {
  const f = await fixture(t);
  f.edges[1].parent = f.files[0];
  for (const [index, input] of [100, 50, 30].entries()) {
    const records = [
      { type: 'session', id: `agent-${index}`, cwd: f.cwd, version: 3 },
      {
        type: 'message',
        id: 'a',
        parentId: null,
        message: { role: 'assistant', content: [], usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 } },
      },
    ];
    if (!index)
      records.push(
        {
          type: 'child_usage_attributed',
          id: 'one',
          parentId: 'a',
          targetId: 'a',
          childUsage: { input: 50 },
          aggregateUsage: { input: 150 },
        },
        {
          type: 'child_usage_attributed',
          id: 'two',
          parentId: 'one',
          targetId: 'a',
          childUsage: { input: 30 },
          aggregateUsage: { input: 180 },
        },
      );
    await writeFile(f.files[index], records.map(JSON.stringify).join('\n') + '\n');
  }
  const history = await f.store.history('agent-0');
  assert.equal(history.messages.at(-1).usage.input, 180);
  assert.equal(history.messages.at(-1).ownUsage.input, 100);
  const { session } = await f.inspector.inspect(f.cwd, 'agent-0');
  assert.equal(session.usage.input, 100);
  assert.equal(session.lastRequestUsage.input, 100);
  assert.equal(session.totalUsage.input, 180);
});

test('real inspector HTTP cache refreshes on run events and never crosses runs', async (t) => {
  const f = await fixture(t, { children: 0 });
  let input, finish, tokens = 10, reads = 0;
  const runtime = {
    getStatus: async () => ({ available: true }),
    getModels: async () => ({ models: [{ id: 'fixture/m' }], default: { model: 'fixture/m' } }),
    async start(value) {
      input = value;
      const done = new Promise((resolve) => { finish = resolve; });
      return { done, cancel: async () => finish({ status: 'stopped', code: 130 }) };
    },
    async close() { finish?.({ status: 'stopped', code: 130 }); },
  };
  const app = createApp({
    runtime, initialCwd: f.cwd, agentHome: f.agentHome, sessionDir: f.sessionDir,
    dataDir: join(f.dir, 'http-data'), readInspectorEdges: async () => [],
    inspectorClient: {
      getInspector: async () => {
        reads++;
        return { state: { contextUsage: { tokens, contextWindow: 200, percent: tokens / 2 } } };
      },
      close() {},
    },
  });
  t.after(() => app.close());
  await app.store.project({ cwd: f.cwd });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const inspect = async () => {
    const response = await fetch(`${base}/api/inspector?${new URLSearchParams({ cwd: f.cwd, sessionId: 'agent-0' })}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const start = async () => {
    const response = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ cwd: f.cwd, sessionId: 'agent-0', message: 'Fixture', model: 'fixture/m' }),
    });
    assert.equal(response.status, 201, await response.text());
  };
  await start();
  assert.equal((await inspect()).contextUsage.tokens, 10);
  assert.equal((await inspect()).contextUsage.tokens, 10);
  assert.equal(reads, 1, 'same revision uses the two-second snapshot');
  for (const event of [
    { kind: 'message', message: { role: 'assistant', text: 'Fixture', usage: { input: 20 } } },
    { kind: 'message', message: { role: 'system', customType: 'compaction', text: 'Compacted' } },
    { kind: 'runtime', status: 'compacting' },
    { kind: 'status', status: 'turn_end' },
  ]) {
    tokens += 10;
    input.onEvent(event);
    assert.equal((await inspect()).contextUsage.tokens, tokens, JSON.stringify(event));
  }
  input.onEvent({ kind: 'done', status: 'completed', code: 0 });
  finish({ status: 'completed', code: 0 });
  assert.equal((await inspect()).live, false, 'done invalidates live context immediately');
  tokens = 90;
  await start();
  assert.equal((await inspect()).contextUsage?.tokens, 90, 'new run cannot reuse the completed snapshot');
});
