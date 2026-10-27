// Resilient bootstrap: the conversation list must not wait for the engine
// --version check or the cold model catalog. No live agent is ever started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function hangingRuntime() {
  const calls = { status: 0, models: 0 };
  const answered = { status: { available: true, version: 'fixture', nodeVersion: 'fixture' } };
  const catalog = {
    models: [{ id: 'fixture/model', name: 'Fixture', provider: 'fixture' }],
    default: { model: 'fixture/model' },
  };
  let released = false;
  let releaseStatus = () => {};
  let releaseModels = () => {};
  return {
    calls,
    async getStatus() {
      calls.status += 1;
      if (released) return answered.status;
      return new Promise((resolve) => {
        releaseStatus = () => resolve(answered.status);
      });
    },
    async getModels() {
      calls.models += 1;
      if (released) return catalog;
      return new Promise((resolve) => {
        releaseModels = () => resolve(catalog);
      });
    },
    async close() {},
    release() {
      released = true;
      releaseStatus();
      releaseModels();
    },
  };
}

async function fixture(t, runtime) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-bootstrap-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'local');
  const agentHome = join(root, 'agent');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(agentHome, { recursive: true }),
  ]);
  await writeFile(
    join(sessionDir, 'seed-session.jsonl'),
    [
      { type: 'session', id: 'seed-session', cwd, timestamp: '2026-10-01T12:00:00.000Z' },
      { type: 'message', id: 'seed-1', parentId: null, message: { role: 'user', content: 'Seed' } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: cwd, runtime });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      runtime.release();
      app.server.closeAllConnections();
      await app.close();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function api(path) {
    return new Promise((done, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-JSON */
          }
          done({ status: response.statusCode, text, json });
        });
      });
      req.setTimeout(10000, () => req.destroy(new Error('fixture HTTP timeout')));
      req.on('error', reject);
      req.end();
    });
  }
  return { root, cwd, app, api };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('light bootstrap resolves while runtime status and models hang', async (t) => {
  const runtime = hangingRuntime();
  const f = await fixture(t, runtime);
  const response = await withTimeout(
    f.api('/api/bootstrap?light=1'),
    5000,
    'light bootstrap must not await runtime',
  );
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.light, true);
  assert.ok(Array.isArray(response.json.projects), 'conversation list source present');
  assert.ok(Array.isArray(response.json.runs));
  assert.equal(response.json.preferences?.attachments, true);
  assert.ok('subagentModel' in response.json, 'hydrate guard input present for sanitizer');
  assert.ok(!('version' in response.json) && !('models' in response.json), 'slow stages stay out of light');
  assert.equal(runtime.calls.status, 0, 'light must not touch --version');
  assert.equal(runtime.calls.models, 0, 'light must not warm the model catalog');
  runtime.release();
});

test('classic bootstrap keeps its full shape once the runtime answers', async (t) => {
  const runtime = hangingRuntime();
  const f = await fixture(t, runtime);
  runtime.release();
  const response = await withTimeout(f.api('/api/bootstrap'), 5000, 'classic bootstrap must resolve');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.light, undefined);
  assert.ok(response.json.version?.version, 'engine version present');
  assert.ok(Array.isArray(response.json.models?.models), 'model catalog present');
  assert.ok('subagentModel' in response.json);
  assert.equal(response.json.preferences?.attachments, true);
  assert.ok(typeof response.json.projects?.[0]?.metricsId === 'string', 'metrics id preserved');
});

test('concurrent light bootstraps share one overview scan', async (t) => {
  const runtime = hangingRuntime();
  const f = await fixture(t, runtime);
  const store = f.app.store;
  const original = store.overview.bind(store);
  let scans = 0;
  store.overview = async () => {
    scans += 1;
    await delay(300);
    return original();
  };
  // Prime once: joins (or outlasts) the startup index scan so the
  // concurrent window below measures only the bootstrap requests.
  await withTimeout(f.api('/api/bootstrap?light=1'), 5000, 'prime light bootstrap must resolve');
  scans = 0;
  const responses = await withTimeout(
    Promise.all([
      f.api('/api/bootstrap?light=1'),
      f.api('/api/bootstrap?light=1'),
      f.api('/api/bootstrap?light=1'),
    ]),
    5000,
    'concurrent light bootstraps must resolve',
  );
  for (const response of responses) assert.equal(response.status, 200, response.text);
  assert.equal(scans, 1, 'retries must not multiply server scans');
  store.overview = original;
  runtime.release();
});

test('pending model discovery stays single-flight beyond its normal cache TTL', async (t) => {
  const runtime = hangingRuntime();
  const f = await fixture(t, runtime);
  const first = f.api('/api/models');
  await withTimeout(
    (async () => {
      while (!runtime.calls.models) await delay(5);
    })(),
    3000,
    'models request started',
  );
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 6001);
  const second = f.api('/api/models');
  await delay(50);
  assert.equal(runtime.calls.models, 1, 'retry shares discovery still in progress');
  clock.mock.restore();
  runtime.release();
  const responses = await Promise.all([first, second]);
  assert.ok(responses.every((r) => r.status === 200));
});
