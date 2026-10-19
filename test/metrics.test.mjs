import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import studioMetrics, { rateLimitHeaders } from '../runtime/studio-metrics-extension.mjs';
import { createMetrics, metricsProjectId } from '../lib/metrics.mjs';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const usage = { input: 20, output: 10, cacheRead: 60, cacheWrite: 20, cost: { total: 0.25 } };
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-metrics-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
function extension(t, directory) {
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
    sessionManager: {
      getSessionId: () => 'session-one',
      getHeader: () => ({ parentSession: '/sessions/root.jsonl', rlmDepth: 1 }),
    },
  };
  return { handlers, emit: (name, event = {}, context = ctx) => handlers.get(name)(event, context) };
}

test('metrics extension records only metadata, own usage, timing and allowlisted numeric quota headers', async (t) => {
  const root = await temporary(t);
  const { emit, handlers } = extension(t, root);
  for (const type of ['agent_start', 'agent_end', 'turn_start']) assert.equal(handlers.has(type), false);
  emit('after_provider_response', {
    status: 429,
    headers: {
      Authorization: 'secret-auth',
      Cookie: 'secret-cookie',
      'x-request-id': 'secret-id',
      'x-ratelimit-secret-id': '123',
      'x-ratelimit-limit-requests': '100',
      'anthropic-ratelimit-input-tokens-remaining': '9000',
      'retry-after': '2',
      'x-ratelimit-reset-tokens': '1m2s',
      'openai-ratelimit-remaining-tokens': '40',
      'x-ratelimit-limit-tokens': 'secret-prompt',
    },
  });
  emit('message_end', { message: { role: 'user', content: 'secret-prompt' } });
  emit('message_end', {
    message: {
      role: 'assistant',
      timestamp: Date.now(),
      provider: 'fixture',
      model: 'model',
      usage,
      stopReason: 'stop',
      content: 'secret-response',
    },
  });
  emit('tool_execution_end', { args: { secret: 'secret-args' }, result: 'secret-result', isError: true });
  emit('session_compact', { summary: 'secret-summary' });
  emit('turn_end');
  await emit('session_shutdown');
  const names = await readdir(root);
  assert.equal(names.length, 1);
  const raw = await readFile(join(root, names[0]), 'utf8');
  assert.doesNotMatch(raw, /secret|content|args|Authorization|Cookie|request-id/);
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 5);
  assert.match(names[0], /^\d{4}-\d{2}-\d{2}--session-one-\d+\.jsonl$/);
  assert.equal(rows[0].headers['retry-after'], '2');
  assert.equal(rows[1].usage.cost, 0.25);
  assert.equal(rows[1].parentSession, 'root.jsonl');
  assert.equal(rows[1].depth, 1);
  assert.ok(rows.every((row) => row.durationMs === undefined));
  assert.equal(rows[2].toolCalls, 1);
});

test('metrics extension disabled or broken filesystem/context never breaks an event', async (t) => {
  const root = await temporary(t);
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'x');
  const { emit } = extension(t, file);
  assert.doesNotThrow(() => emit('turn_end'));
  assert.doesNotThrow(() => emit('message_end', {}, { sessionManager: null }));
  await assert.doesNotReject(() => emit('session_shutdown'));
  delete process.env.PRIME_STUDIO_METRICS_DIR;
  studioMetrics({
    on() {
      assert.fail('Disabled extension registered a handler');
    },
  });
  assert.deepEqual(rateLimitHeaders({ 'set-cookie': 'secret', 'x-ratelimit-id': '123' }), {});
});

test('ledger backfill is incremental, idempotent and excludes child attribution overlays', async (t) => {
  const root = await temporary(t),
    sessionDir = join(root, 'sessions');
  await mkdir(sessionDir);
  const ts = Date.now(),
    project = join(root, 'project');
  const message = {
    type: 'message',
    id: 'm1',
    timestamp: new Date(ts).toISOString(),
    message: {
      role: 'assistant',
      timestamp: ts,
      provider: 'fixture',
      model: 'model',
      usage,
      content: 'secret-response',
    },
  };
  await writeFile(
    join(sessionDir, 'parent.jsonl'),
    jsonl([
      { type: 'session', id: 'parent', cwd: project },
      message,
      {
        type: 'child_usage_attributed',
        targetId: 'm1',
        childUsage: usage,
        aggregateUsage: { ...usage, input: 500 },
      },
    ]),
  );
  const artifactDir = join(root, 'session-artifacts');
  await mkdir(join(artifactDir, 'parent', 'sub-child'), { recursive: true });
  await writeFile(
    join(artifactDir, 'parent', 'sub-child', 'child.jsonl'),
    jsonl([{ type: 'session', id: 'child', cwd: project, parentSession: 'parent', rlmDepth: 1 }, message]),
  );
  const metrics = createMetrics({ dataDir: root, sessionDir, artifactDir, resolveProject: async (cwd) => ({ cwd }) });
  t.after(() => metrics.close());
  await metrics.refresh();
  let result = await metrics.summary({ groupBy: 'model' });
  assert.equal(result.complete, true);
  assert.equal(result.totals.messages, 2);
  assert.deepEqual(result.totals.tokens, { input: 40, output: 20, cacheRead: 120, cacheWrite: 40 });
  assert.equal(result.totals.cost, 0.5);
  assert.equal(result.totals.cacheHitRatio, 0.6);
  assert.equal(result.groups[0].key, 'fixture/model');
  await metrics.refresh();
  await metrics.close();
  const reopened = createMetrics({ dataDir: root, sessionDir, artifactDir });
  t.after(() => reopened.close());
  await reopened.refresh();
  const projectId = (await reopened.summary({ groupBy: 'project' })).groups[0].key;
  assert.match(projectId, /^[a-f0-9]{64}$/);
  result = await reopened.summary({ project: projectId });
  assert.equal(result.totals.messages, 2);
  // An incomplete appended line is not consumed; a later append finishes it.
  const next = JSON.stringify({ ...message, id: 'm2', message: { ...message.message, timestamp: ts + 1 } });
  await appendFile(join(sessionDir, 'parent.jsonl'), next.slice(0, 40));
  await reopened.refresh();
  assert.equal((await reopened.summary()).totals.messages, 2);
  await appendFile(join(sessionDir, 'parent.jsonl'), next.slice(40) + '\n');
  await reopened.refresh();
  assert.equal((await reopened.summary()).totals.messages, 3);
  const ledger = await readFile(
    join(root, 'metrics', new Date(ts).toISOString().slice(0, 10) + '.jsonl'),
    'utf8',
  );
  assert.doesNotMatch(ledger, /secret-response|content|aggregateUsage/);
});

test('raw ingestion deduplicates historical usage, sanitizes input, and prunes 90-day data', async (t) => {
  const root = await temporary(t),
    sessionDir = join(root, 'sessions');
  await mkdir(sessionDir);
  const ts = Date.now(),
    day = new Date(ts).toISOString().slice(0, 10);
  const metrics = createMetrics({ dataDir: root, sessionDir });
  t.after(() => metrics.close());
  await metrics.refresh();
  const row = {
    id: 'provider-event',
    type: 'message_end',
    sessionId: 'one',
    ts,
    messageTs: ts,
    cwd: '/project',
    provider: 'fixture',
    model: 'model',
    usage,
    content: 'secret',
  };
  await writeFile(
    join(metrics.rawDir, 'one.jsonl'),
    jsonl([
      row,
      row,
      {
        ...row,
        id: 'response',
        type: 'after_provider_response',
        status: 503,
        headers: { authorization: 'secret', 'retry-after': '1' },
      },
      { ...row, id: 'unknown-cost', messageTs: ts + 1, usage: { input: 5 } },
    ]),
  );
  await writeFile(
    join(sessionDir, 'one.jsonl'),
    jsonl([
      { type: 'session', id: 'one', cwd: '/project' },
      {
        type: 'message',
        id: 'm',
        message: { role: 'assistant', timestamp: ts, provider: 'fixture', model: 'model', usage },
      },
    ]),
  );
  await writeFile(join(root, 'metrics', '2000-01-01.jsonl'), jsonl([row]));
  const stale = join(metrics.rawDir, 'stale.jsonl');
  await writeFile(stale, jsonl([row]));
  await utimes(stale, new Date('2000-01-01'), new Date('2000-01-01'));
  await metrics.refresh();
  const results = await Promise.all([metrics.summary(), metrics.summary(), metrics.summary()]);
  for (const result of results) {
    assert.equal(result.totals.messages, 2);
    assert.equal(result.totals.errors['5xx'], 1);
    assert.equal(result.totals.costKnown, false);
    assert.equal(result.totals.unknownCostMessages, 1);
    assert.equal(result.totals.cost, 0.25);
  }
  assert.ok(!(await readdir(join(root, 'metrics'))).includes('2000-01-01.jsonl'));
  assert.ok(!(await readdir(metrics.rawDir)).includes('stale.jsonl'));
  assert.doesNotMatch(
    await readFile(join(root, 'metrics', `${day}.jsonl`), 'utf8'),
    /secret|authorization|content/,
  );
  await assert.rejects(metrics.summary({ from: '2026-02-30' }), { status: 400 });
  await assert.rejects(metrics.summary({ groupBy: 'secret' }), { status: 400 });
});

test('run timing uses first nonempty text/thinking delta and never stores output/errors', async (t) => {
  const root = await temporary(t);
  let clock = Date.now();
  const metrics = createMetrics({ dataDir: root, now: () => clock });
  t.after(() => metrics.close());
  const run = {
    id: 'run',
    startedAt: new Date(clock).toISOString(),
    model: 'fixture/model',
    cwd: '/project',
  };
  metrics.noteEvent(run, { kind: 'start' });
  clock += 30;
  metrics.noteEvent(run, { kind: 'tool', delta: 'secret-tool' });
  metrics.noteEvent(run, { kind: 'text', delta: '' });
  clock += 20;
  metrics.noteEvent(run, { kind: 'thinking', delta: 'secret-thinking' });
  clock += 50;
  metrics.noteEvent(run, { kind: 'text', delta: 'secret-response' });
  clock += 100;
  metrics.noteEvent(run, { kind: 'done', status: 'failed', error: 'secret-error' });
  metrics.noteEvent(run, { kind: 'done', status: 'failed' });
  await metrics.refresh();
  const result = await metrics.summary();
  assert.equal(result.totals.runs, 1);
  assert.equal(result.totals.finishedRuns, 1);
  assert.equal(result.totals.completedRuns, 0);
  assert.equal(result.totals.timeToFirstToken.medianMs, 50);
  assert.equal(result.totals.duration.avgMs, 200);
  assert.equal(result.totals.errors.runtime, 1);
  const raw = await readFile(
    join(root, 'metrics', new Date(clock).toISOString().slice(0, 10) + '.jsonl'),
    'utf8',
  );
  assert.doesNotMatch(raw, /secret/);
});

async function serverFixture(t) {
  const root = await temporary(t),
    cwd = join(root, 'project'),
    sessionDir = join(root, 'sessions');
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  const controls = [];
  const runtime = {
    getStatus: async () => ({ available: true }),
    getModels: async () => ({
      models: [{ id: 'fixture/model', provider: 'fixture' }],
      default: { model: 'fixture/model' },
    }),
    async start(input) {
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const control = { done, emit: input.onEvent, cancel: async () => resolveDone({ status: 'stopped' }) };
      controls.push(control);
      return control;
    },
    close: async () => {
      for (const control of controls) await control.cancel();
    },
  };
  const app = createApp({
    dataDir: root,
    agentHome: join(root, 'agent'),
    sessionDir,
    initialCwd: cwd,
    runtime,
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, controls, base, cwd, artifactDir: join(root, 'agent', 'session-artifacts') };
}

test('createApp fixture run emits durable timing/status and read-only internal aggregates', async (t) => {
  const { app, controls, base, cwd } = await serverFixture(t);
  const response = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, message: 'secret-prompt', model: 'fixture/model' }),
  });
  assert.equal(response.status, 201, await response.text());
  controls[0].emit({ kind: 'thinking', delta: 'secret-response' });
  controls[0].emit({ kind: 'done', status: 'completed', code: 0 });
  await app.metrics.refresh();
  const result = await (await fetch(`${base}/api/metrics/summary?groupBy=model`)).json();
  assert.equal(result.totals.runs, 1);
  assert.equal(result.totals.completedRuns, 1);
  assert.ok(result.totals.timeToFirstToken.avgMs >= 0);
  assert.ok(result.totals.duration.medianMs >= result.totals.timeToFirstToken.medianMs);
  assert.doesNotMatch(JSON.stringify(result), /secret-prompt|secret-response/);
  assert.equal((await fetch(`${base}/api/metrics/summary?groupBy=bad`)).status, 400);
  assert.equal((await fetch(`${base}/api/metrics/summary`, { method: 'POST' })).status, 404);
});

test('LAN consultation allows authenticated metrics GET, rejects anonymous reads and writes', async (t) => {
  const { app, cwd } = await serverFixture(t);
  const run = { id: 'lan-private', cwd, model: 'fixture/model', startedAt: new Date().toISOString() };
  app.metrics.noteEvent(run, { kind: 'done', status: 'completed' });
  app.metrics.noteEvent({ ...run, id: 'removed-project', cwd: 'C:\\private\\removed-project' }, { kind: 'done' });
  const salt = 'e54d6dd09bb15f7c347b38b671472aa9',
    code = '49283175';
  const gateway = createLanGateway({
    host: '127.0.0.1',
    port: 0,
    upstreamPort: app.server.address().port,
    config: { salt, codeHash: hashAccessCode(code, salt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  assert.equal((await fetch(`${base}/api/metrics/summary`)).status, 401);
  const login = await fetch(`${base}/lan/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }).toString(),
  });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/metrics/summary?groupBy=project`, { headers: { Cookie } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.groups.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private|studio-metrics-|[A-Z]:|\\/);
  assert.deepEqual(result.groups.map((group) => group.name).sort(), ['project', 'removed-project']);
  for (const group of result.groups) {
    assert.match(group.key, /^[a-f0-9]{64}$/);
    const filtered = await (await fetch(`${base}/api/metrics/summary?project=${group.key}`, { headers: { Cookie } })).json();
    assert.equal(filtered.totals.runs, 1);
    assert.equal(filtered.project, group.key);
  }
  assert.equal((await fetch(`${base}/api/metrics/summary?project=${encodeURIComponent(cwd)}`, { headers: { Cookie } })).status, 400);
  assert.equal(
    (await fetch(`${base}/api/metrics/summary`, { method: 'POST', headers: { Cookie } })).status,
    405,
  );
});

test('summary usage is a separate bucket, included once in total cost and never counted as a turn', async (t) => {
  const root = await temporary(t),
    sessionDir = join(root, 'sessions');
  await mkdir(sessionDir);
  const ts = Date.now(),
    timestamp = new Date(ts).toISOString();
  const { emit } = extension(t, join(root, 'metrics', 'raw'));
  emit('session_compact', {
    compactionEntry: { id: 'compact', timestamp, usage, summary: 'secret-summary' },
  });
  emit('session_tree', { summaryEntry: { id: 'branch', timestamp, usage, summary: 'secret-summary' } });
  await emit('session_shutdown');
  await writeFile(
    join(sessionDir, 'one.jsonl'),
    jsonl([
      { type: 'session', id: 'session-one', cwd: '/fixture/project' },
      { type: 'compaction', id: 'compact', timestamp, usage, summary: 'secret-summary' },
      { type: 'branch_summary', id: 'branch', timestamp, usage, summary: 'secret-summary' },
    ]),
  );
  const metrics = createMetrics({ dataDir: root, sessionDir });
  t.after(() => metrics.close());
  await metrics.refresh();
  const result = await metrics.summary();
  assert.equal(result.totals.turns, 0);
  assert.equal(result.totals.messages, 0);
  assert.equal(result.totals.compactions, 1);
  assert.equal(result.totals.summary.count, 2);
  assert.equal(result.totals.summary.cost, 0.5);
  assert.equal(result.totals.cost, 0.5);
  assert.equal(result.totals.summary.tokens.input, 40);
});

test('metrics extension partitions a long-lived session by UTC event day', async (t) => {
  const root = await temporary(t);
  const { emit } = extension(t, root);
  t.mock.method(Date, 'now', () => Date.parse('2026-05-01T23:59:59Z'));
  emit('turn_end');
  Date.now.mock.mockImplementation(() => Date.parse('2026-05-02T00:00:01Z'));
  emit('turn_end');
  await emit('session_shutdown');
  const names = (await readdir(root)).sort();
  assert.equal(names.length, 2);
  assert.ok(names[0].startsWith('2026-05-01--'));
  assert.ok(names[1].startsWith('2026-05-02--'));
});

test('summary waits for overlapping historical ingestion and shares identical in-flight work', async (t) => {
  const root = await temporary(t), sessionDir = join(root, 'sessions');
  await mkdir(sessionDir);
  const ts = Date.now();
  await writeFile(join(sessionDir, 'one.jsonl'), jsonl([
    { type: 'session', id: 'one', cwd: '/private/project' },
    { type: 'message', message: { role: 'assistant', timestamp: ts, usage } },
  ]));
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const metrics = createMetrics({ dataDir: root, sessionDir, resolveProject: async (cwd) => {
    entered();
    await gate;
    return { cwd };
  } });
  t.after(() => metrics.close());
  const scan = metrics.refresh();
  await started;
  const first = metrics.summary(), second = metrics.summary();
  let settled = false;
  first.then(() => { settled = true; });
  // Let the old summary implementation finish enumerating its empty ledger.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await scan;
  assert.equal(settled, false, 'summary must not settle before its overlapping scan');
  assert.strictEqual(first, second, 'identical concurrent reads share one scan and allocation');
  assert.equal((await first).totals.messages, 1);
  assert.equal((await first).complete, true);
});

test('summary budgets physical duplicate, invalid rows and unterminated bytes', async (t) => {
  const root = await temporary(t), ts = Date.now();
  const metrics = createMetrics({ dataDir: root });
  t.after(() => metrics.close());
  await metrics.refresh();
  const file = join(root, 'metrics', new Date(ts).toISOString().slice(0, 10) + '.jsonl');
  const row = JSON.stringify({ id: 'same', type: 'turn_end', ts });
  await writeFile(file, (row + '\ninvalid\n').repeat(125000) + jsonl([{ id: 'late', type: 'turn_end', ts }]));
  let result = await metrics.summary();
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.totals.turns, 1);
  assert.equal(result.rowsRead, result.maxRecords);
  await writeFile(file, Buffer.alloc(64 * 1024 * 1024 + 1, 120));
  result = await metrics.summary();
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.bytesRead, result.maxBytes);
});

test('maintenance ingests and prunes at deferred startup and throttled run completion without summary reads', async (t) => {
  const root = await temporary(t), sessionDir = join(root, 'sessions');
  const rawDir = join(root, 'metrics', 'raw'), cursorDir = join(root, 'metrics', 'cursors');
  await mkdir(rawDir, { recursive: true });
  await mkdir(cursorDir);
  await mkdir(sessionDir);
  const ts = Date.now(), date = new Date(ts).toISOString().slice(0, 10);
  await writeFile(join(rawDir, '2000-01-01--long-lived-1.jsonl'), '{}\n');
  await writeFile(join(root, 'metrics', '2000-01-01.jsonl'), '{}\n');
  await writeFile(join(cursorDir, 'orphan.json'), '{}');
  await writeFile(join(rawDir, `${date}--one-1.jsonl`), jsonl([{ id: 'live', type: 'turn_end', ts }]));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = ts;
  const metrics = createMetrics({ dataDir: root, sessionDir, now: () => clock });
  t.after(() => metrics.close());
  // Wait for filesystem progress with a bounded real immediate loop, not summary()/refresh().
  const until = async (check) => {
    const deadline = performance.now() + 5000;
    while (!(await check())) {
      assert.ok(performance.now() < deadline, 'maintenance did not complete');
      await new Promise(setImmediate);
    }
  };
  t.mock.timers.tick(1000);
  const ledger = join(root, 'metrics', `${date}.jsonl`);
  await until(async () => (await readdir(join(root, 'metrics'))).includes(`${date}.jsonl`));
  await until(async () => !(await readdir(cursorDir)).includes('orphan.json'));
  assert.ok(!(await readdir(rawDir)).includes('2000-01-01--long-lived-1.jsonl'));
  assert.ok(!(await readdir(join(root, 'metrics'))).includes('2000-01-01.jsonl'));
  await writeFile(join(rawDir, `${date}--two-1.jsonl`), jsonl([{ id: 'later', type: 'turn_end', ts }]));
  clock += 31000;
  metrics.noteEvent({ id: 'completed', startedAt: new Date(clock).toISOString() }, { kind: 'done' });
  t.mock.timers.tick(31000);
  await until(async () => (await readFile(ledger, 'utf8')).includes('later'));
});

test('ingestion drops unused lifecycle events and duration fields', async (t) => {
  const root = await temporary(t), ts = Date.now();
  const metrics = createMetrics({ dataDir: root });
  t.after(() => metrics.close());
  await metrics.refresh();
  await writeFile(join(metrics.rawDir, 'legacy.jsonl'), jsonl(
    ['agent_start', 'agent_end', 'turn_start', 'turn_end'].map((type) => ({ id: type, type, ts, durationMs: 42 })),
  ));
  await metrics.refresh();
  const content = await readFile(join(root, 'metrics', new Date(ts).toISOString().slice(0, 10) + '.jsonl'), 'utf8');
  assert.doesNotMatch(content, /agent_start|agent_end|turn_start|durationMs/);
  assert.equal((await metrics.summary()).totals.turns, 1);
});

test('server summary backfills artifact-only historical descendants', async (t) => {
  const { base, cwd, artifactDir } = await serverFixture(t);
  const childDir = join(artifactDir, 'historical-root', 'sub-child');
  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, 'child.jsonl'), jsonl([
    { type: 'session', id: 'historical-child', parentSession: 'historical-root', rlmDepth: 1, cwd },
    { type: 'message', message: { role: 'assistant', timestamp: Date.now(), usage } },
  ]));
  const result = await (await fetch(`${base}/api/metrics/summary`)).json();
  assert.equal(result.complete, true);
  assert.equal(result.totals.messages, 1);
});

test('summary cannot claim complete if another ingestion finishes during its ledger read', async (t) => {
  const root = await temporary(t), ts = Date.now();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const metrics = createMetrics({ dataDir: root, resolveProject: async (cwd) => {
    if (cwd === '/private/project') {
      entered();
      await gate;
    }
    return { cwd, name: 'Registered project' };
  } });
  t.after(() => metrics.close());
  await metrics.refresh();
  const file = join(root, 'metrics', new Date(ts).toISOString().slice(0, 10) + '.jsonl');
  await writeFile(file, jsonl([{ id: 'one', type: 'turn_end', ts, project: '/private/project' }]));
  const pending = metrics.summary({ groupBy: 'project' });
  await started; // The summary has snapshotted the file and is resolving its safe display name.
  await writeFile(join(metrics.rawDir, 'late.jsonl'), jsonl([{ id: 'two', type: 'turn_end', ts }]));
  await metrics.refresh(); // This ingestion finishes while the earlier file snapshot is held.
  release();
  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.groups[0].name, 'Registered project');
  assert.equal((await metrics.summary()).totals.turns, 2);
});

test('run completion during an active maintenance scan schedules a later ingestion pass', async (t) => {
  const root = await temporary(t), ts = Date.now();
  let clock = ts, release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const metrics = createMetrics({ dataDir: root, now: () => clock, resolveProject: async (cwd) => {
    if (cwd === '/blocked') { entered(); await gate; }
    return { cwd };
  } });
  t.after(() => metrics.close());
  await mkdir(metrics.rawDir, { recursive: true });
  await writeFile(join(metrics.rawDir, 'first.jsonl'), jsonl([{ id: 'first', type: 'turn_end', ts, cwd: '/blocked' }]));
  const scan = metrics.refresh();
  await started;
  // The raw-directory listing is already snapshotted by the active scan.
  await writeFile(join(metrics.rawDir, 'later.jsonl'), jsonl([{ id: 'later', type: 'turn_end', ts }]));
  metrics.noteEvent({ id: 'completed', startedAt: new Date(ts).toISOString() }, { kind: 'done' });
  t.mock.timers.tick(1000);
  release();
  await scan;
  clock += 31000;
  t.mock.timers.tick(31000);
  const file = join(root, 'metrics', new Date(ts).toISOString().slice(0, 10) + '.jsonl');
  const deadline = performance.now() + 2000;
  while (!(await readFile(file, 'utf8')).includes('later')) {
    assert.ok(performance.now() < deadline, 'completion ingestion was lost behind an active scan');
    await new Promise(setImmediate);
  }
});


test('overview exposes the same opaque project id as filtered metrics', async (t) => {
  const { base, cwd, app } = await serverFixture(t);
  const overview = await (await fetch(`${base}/api/overview`)).json();
  const project = overview.projects.find((entry) => entry.cwd === cwd);
  assert.equal(project.metricsId, metricsProjectId(cwd));
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(bootstrap.projects.find((entry) => entry.cwd === cwd).metricsId, project.metricsId);
  assert.match(project.metricsId, /^[a-f0-9]{64}$/);
  app.metrics.noteEvent({ id: 'failed', cwd, model: 'fixture/m', startedAt: new Date().toISOString() }, { kind: 'done', status: 'failed' });
  app.metrics.noteEvent({ id: 'stopped', cwd, model: 'fixture/m', startedAt: new Date().toISOString() }, { kind: 'done', status: 'stopped' });
  const result = await (await fetch(`${base}/api/metrics/summary?project=${project.metricsId}`)).json();
  assert.equal(result.totals.runs, 2);
  assert.equal(result.totals.failedRuns, 1, 'stopped runs are not failures');
});
