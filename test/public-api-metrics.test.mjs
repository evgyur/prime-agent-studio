import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createMetrics, metricsProjectId } from '../lib/metrics.mjs';
import { createPublicApi, publicProjectId } from '../lib/public-api.mjs';
import { createPublicApiAccess } from '../lib/public-api-access.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'public-metrics-'));
  const projects = ['visible', 'hidden'].map((name) => ({ cwd: join(root, name), name, sessions: [] }));
  const sessionDir = join(root, 'sessions');
  await mkdir(sessionDir);
  for (const [i, project] of projects.entries())
    await writeFile(join(sessionDir, `${i}.jsonl`), [
      { type: 'session', id: `session-${i}`, cwd: project.cwd },
      ...['2026-10-18', '2026-10-19'].map((day) => ({ type: 'message', id: day,
        timestamp: `${day}T12:00:00Z`, message: { role: 'assistant', provider: 'fixture', model: project.name,
          usage: { input: (i + 1) * 10, output: 2, cost: { total: i + 1 } } } })),
    ].map(JSON.stringify).join('\n') + '\n');
  const metrics = createMetrics({ dataDir: root, sessionDir, now: () => Date.parse('2026-10-20T00:00:00Z') });
  const access = createPublicApiAccess({ dataDir: root });
  await access.configure({ enabled: true, revision: 0 });
  async function token(projectIds) {
    const state = await access.get();
    return (await access.createToken({ name: 'fixture', scopes: ['read'], projectIds, revision: state.revision })).credential;
  }
  const restricted = await token([publicProjectId(projects[0].cwd)]);
  const all = await token(['*']);
  const api = createPublicApi({ access, metrics, dataDir: root, store: { overview: async () => ({ projects }) } });
  const server = createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await api.close();
    await new Promise((resolve) => server.close(resolve));
    await metrics.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const get = async (query = '', credential = restricted) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/metrics${query}`, {
      headers: credential ? { Authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  return { get, projects, all, metrics };
}

test('public metrics authenticate and aggregate only authorized projects in every grouping', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get('', '')).status, 401);
  for (const groupBy of ['day', 'model', 'project']) {
    const result = await f.get(`?groupBy=${groupBy}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.totals.tokens.input, 20);
    assert.equal(result.body.totals.messages, 2);
    for (const key of ['rowsRead', 'bytesRead', 'dropped']) assert.equal(result.body[key], null);
    assert.doesNotMatch(JSON.stringify(result.body), /hidden|session-|public-metrics-/);
    if (groupBy === 'project') assert.equal(result.body.groups[0].key, publicProjectId(f.projects[0].cwd));
  }
  assert.equal((await f.get('', f.all)).body.totals.tokens.input, 60);
  assert.equal((await f.get(`?project=${publicProjectId(f.projects[1].cwd)}`)).status, 404);
  assert.equal((await f.get(`?project=${metricsProjectId(f.projects[0].cwd)}`)).status, 400);
  const filtered = await f.get(`?project=${publicProjectId(f.projects[0].cwd)}`, f.all);
  assert.equal(filtered.body.totals.tokens.input, 20);
  assert.equal(filtered.body.project, publicProjectId(f.projects[0].cwd));
});

test('public metrics validate date bounds and query fields, with inclusive UTC dates', async (t) => {
  const f = await fixture(t);
  for (const query of ['from=2026-02-30', 'from=2026-10-20&to=2026-10-19', 'from=',
    'to=tomorrow', 'groupBy=provider', 'groupBy=', 'from=2026-10-18&from=2026-10-19', 'cwd=secret'])
    assert.equal((await f.get(`?${query}`)).status, 400, query);
  const result = await f.get('?from=2026-10-19&to=2026-10-19');
  assert.equal(result.status, 200);
  assert.equal(result.body.totals.messages, 1);
  assert.equal(result.body.from, '2026-10-19');
  assert.equal(result.body.to, '2026-10-19');
});

test('metrics allowlist is applied before aggregation and empty means no projects', async (t) => {
  const f = await fixture(t);
  const query = { groupBy: 'model' };
  const [allowed, empty, all] = await Promise.all([
    f.metrics.summary({ ...query, projectIds: [metricsProjectId(f.projects[0].cwd)] }),
    f.metrics.summary({ ...query, projectIds: [] }),
    f.metrics.summary(query),
  ]);
  assert.equal(allowed.totals.tokens.input, 20);
  assert.equal(empty.totals.messages, 0);
  assert.equal(all.totals.tokens.input, 60);
});
