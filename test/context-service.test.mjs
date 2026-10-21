import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';
import { metricsProjectId } from '../lib/metrics.mjs';
import { createContextService } from '../lib/context-service.mjs';

async function fixture(t, extraOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-context-service-'));
  const cwd = join(root, 'project'), dataDir = join(root, 'data'), sessionDir = join(root, 'sessions'), agentHome = join(root, 'agent');
  await Promise.all([cwd, dataDir, sessionDir, agentHome].map((p) => mkdir(p)));
  await writeFile(join(cwd, 'code.js'), 'export const fixture = 1;');
  await writeFile(join(cwd, '.env.local'), 'SECRET=fixture');
  await writeFile(join(sessionDir, 'fixture.jsonl'), JSON.stringify({ type: 'session', id: 'fixture-session', cwd, timestamp: '2026-10-19T00:00:00.000Z' }) + '\n');
  const calls = [];
  const index = { ensureProject: async () => {}, refresh: async (p, o) => { calls.push(o); }, status: async () => ({ state: 'ready', files: 1, symbols: 1, updatedAt: null }), search: async (p, q) => ({ state: 'ready', results: [{ path: 'code.js', ...q }] }), close: async () => {} };
  const starts = [];
  const runtime = { start: async (input) => { starts.push(input); return { done: Promise.resolve({ status: 'completed', code: 0 }), cancel: async () => {} }; }, getStatus: async () => ({ available: true }), getModels: async () => ({ models: [], default: {} }), close: async () => {} };
  const app = createApp({ dataDir, sessionDir, agentHome, initialCwd: cwd, runtime, codeIndex: index, ...extraOptions });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const id = metricsProjectId(cwd), route = `/api/projects/${id}/context`;
  const api = async (path = route, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, cwd, dataDir, app, id, route, base, api, calls, index, starts };
}

test('context routes validate ownership, paths, line ranges and origin without providers', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api()).body.enabled, false, 'project context is disabled by default');
  assert.equal((await f.api(f.route, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await f.api(f.route + '?sessionId=other')).status, 404);
  assert.equal((await f.api('/api/projects/' + '0'.repeat(64) + '/context')).status, 404);
  assert.equal((await f.api(f.route, 'PATCH', { pins: [{ path: 'code.js' }] })).status, 400, 'legacy pins are rejected');
  assert.equal((await f.api(f.route, 'PATCH', { exclusions: ['../outside'] })).status, 400);
  assert.equal((await f.api(f.route, 'PATCH', { sessionEnabled: false })).status, 400);
  assert.equal((await f.api(f.route, 'PATCH', { sessionEnabled: false, sessionId: 'other' })).status, 404);
  assert.equal((await f.api(f.route, 'PATCH', { enabled: false }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.api(f.route + '/search', 'POST', { q: '', limit: 500 })).status, 400);
  assert.equal((await f.api(f.route, 'DELETE')).status, 405);
  assert.equal((await f.api(f.route + '/rebuild', 'POST')).status, 202);
});

test('serialized settings preserve concurrent updates and runtime config', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.api(f.route, 'PATCH', { enabled: true });
  const results = await Promise.all([
    f.api(f.route, 'PATCH', { exclusions: ['other.js'] }),
    f.api(f.route, 'PATCH', { sessionId: 'fixture-session', sessionEnabled: false }),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  const state = (await f.api(f.route + '?sessionId=fixture-session')).body;
  assert.equal(state.sessionEnabled, false);
  assert.equal(state.dossier, undefined);
  assert.equal(state.pins, undefined);
  const runtime = await f.app.context.runtimeConfig(f.cwd, 'fixture-session');
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.dataDir, f.dataDir);
  assert.equal(runtime.projectId, f.id);
  await f.api(f.route, 'PATCH', { exclusions: ['code.js'] });
  assert.deepEqual((await f.api(f.route + '/search', 'POST', { q: 'fixture' })).body.results, []);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'code-index', f.id, 'settings.json'), 'utf8'));
  assert.equal(saved.sessions['fixture-session'], false);
});

test('context SSE sends initial state and settings changes, then releases on disconnect', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(f.base + f.route + '/events?sessionId=fixture-session', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: context/);
  const next = reader.read();
  await f.api(f.route, 'PATCH', { enabled: false });
  let received = new TextDecoder().decode((await next).value);
  while (!received.includes('"enabled":false')) received += new TextDecoder().decode((await reader.read()).value);
  assert.match(received, /"enabled":false/);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('context refuses storage inside a project and disabled snapshots never start the index', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  let statuses = 0;
  f.index.status = async () => { statuses++; return { state: 'ready' }; };
  await f.api(f.route, 'PATCH', { enabled: false });
  const count = statuses;
  assert.equal((await f.api()).body.index.state, 'disabled');
  assert.equal(statuses, count);
  assert.equal((await f.api(f.route + '/rebuild', 'POST')).status, 409);
  const unsafe = createContextService({ dataDir: f.cwd, store: f.app.store, index: f.index });
  await assert.rejects(unsafe.patch(f.id, { enabled: true }), { status: 409 });
  assert.equal((await unsafe.runtimeConfig(f.cwd)).enabled, false);
  await unsafe.close();
});

test('authorized task worktrees explicitly disable wrong-root context tools', { timeout: 15000 }, async (t) => {
  const worktrees = {};
  const f = await fixture(t, { worktrees });
  const cwd = join(f.root, 'managed', 'task');
  await mkdir(cwd, { recursive: true });
  Object.assign(worktrees, {
    managedRoot: join(f.root, 'managed'),
    findByPath: async () => ({ id: 'task' }),
    inspect: async () => ({ worktree: { id: 'task', path: cwd, projectCwd: f.cwd }, task: { id: 'task' } }),
  });
  const result = await f.api('/api/runs', 'POST', { cwd, message: 'Fixture only' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].codeContext.enabled, false);
});

test('run configuration reactivates an evicted writer without waiting for its scan', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.api(f.route, 'PATCH', { exclusions: ['private/**'], sessionId: 'fixture-session', sessionEnabled: false });
  let admitted, release, statusCalls = 0, refreshCalls = 0;
  const admission = new Promise((done) => { admitted = done; });
  const scan = new Promise((done) => { release = done; });
  const index = {
    status: async () => { statusCalls++; return { state: 'not-ready' }; },
    ensureProject: async () => {},
    refresh: async (project, options) => { refreshCalls++; admitted({ project, options }); await scan; },
    close: async () => { release(); },
  };
  const service = createContextService({ dataDir: f.dataDir, store: f.app.store, index });
  t.after(() => service.close());
  assert.equal((await service.runtimeConfig(f.cwd, 'fixture-session')).enabled, false);
  assert.equal(statusCalls, 0);
  await f.api(f.route, 'PATCH', { enabled: true, sessionId: 'fixture-session', sessionEnabled: true });
  const config = await service.runtimeConfig(f.cwd, 'fixture-session');
  assert.equal(config.enabled, true);
  const { project, options } = await admission;
  assert.equal(project.id, f.id);
  assert.equal(project.path, f.cwd);
  assert.deepEqual(options.exclusions, ['private/**']);
  await service.runtimeConfig(f.cwd, 'fixture-session');
  assert.equal(refreshCalls, 1, 'pending activation is shared');
  release();
});


test('generated sources require a validated project opt-in and pass to index and runtime', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api()).body.includeGenerated, false);
  assert.equal((await f.api(f.route, 'PATCH', { includeGenerated: 'yes' })).status, 400);
  assert.equal((await f.api(f.route, 'PATCH', { enabled: true, includeGenerated: true })).status, 200);
  assert.equal((await f.api()).body.includeGenerated, true);
  assert.equal((await f.app.context.runtimeConfig(f.cwd, 'fixture-session')).includeGenerated, true);
  const found = await f.api(f.route + '/search', 'POST', { q: 'fixture' });
  assert.equal(found.body.results[0].includeGenerated, true);
  await f.app.context.ensureAll();
  assert.ok(f.calls.some((call) => call.includeGenerated === true));
});
test('project context is disabled by default, opt-in persists, tab is labeled Beta', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const fresh = await f.api();
  assert.equal(fresh.body.enabled, false);
  assert.equal(fresh.body.index.state, 'disabled');
  assert.equal((await f.app.context.runtimeConfig(f.cwd, 'fixture-session')).enabled, false);
  assert.deepEqual((await f.api(f.route + '/search', 'POST', { q: 'fixture' })).body, { state: 'disabled', results: [] });
  assert.equal((await f.api(f.route + '/rebuild', 'POST')).status, 409);
  assert.equal((await f.api(f.route, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await f.api()).body.enabled, true);
  assert.equal((await f.app.context.runtimeConfig(f.cwd, 'fixture-session')).enabled, true);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'code-index', f.id, 'settings.json'), 'utf8')).enabled, true);
  await f.api(f.route, 'PATCH', { enabled: false });
  assert.equal((await f.api()).body.enabled, false);
  const table = await readFile('public/translations.js', 'utf8');
  assert.ok(table.includes('"en": "Context (Beta)"') && table.includes('"fr": "Contexte (Bêta)"'));
  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('docking.context">Context (Beta)'));
});
