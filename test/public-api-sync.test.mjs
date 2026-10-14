import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

// Real HTTP, token store and project store; the R2 bucket is a fake whose
// targeted pull writes the received conversation like the real sync does.
const sessionFile = (id, cwd) =>
  [
    { type: 'session', id, cwd, timestamp: '2026-10-13T00:00:00.000Z' },
    { type: 'message', id: `${id}-m`, message: { role: 'user', content: 'Fixture' } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n') + '\n';

async function fixture(t, { configured = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-public-sync-'));
  const cwd = join(root, 'project');
  const other = join(root, 'other');
  const sessionDir = join(root, 'sessions');
  await Promise.all([cwd, other, sessionDir, join(root, 'agent')].map((p) => mkdir(p)));
  await writeFile(join(sessionDir, 'local-a.jsonl'), sessionFile('local-a', cwd));
  await writeFile(join(sessionDir, 'other-a.jsonl'), sessionFile('other-a', other));
  const calls = [];
  const sync = {
    async status() {
      return {
        configured,
        running: false,
        lastSync: {
          at: '2026-10-13T12:00:00.000Z',
          ok: true,
          sent: 1,
          pushed: 0,
          received: 2,
          error: 'https://secret.r2',
        },
        sessions: { 'other-a': 'synced' },
        url: 'https://account.r2.cloudflarestorage.com/private-bucket',
      };
    },
    async checkSession(id) {
      calls.push(id);
      if (id === 'remote-new') await writeFile(join(sessionDir, 'remote-new.jsonl'), sessionFile(id, cwd));
      if (id === 'remote-other')
        await writeFile(join(sessionDir, 'remote-other.jsonl'), sessionFile(id, other));
      if (id === 'broken') throw new Error('PUT https://account.r2.cloudflarestorage.com failed: AKIA-key');
      return { state: 'synced', changed: id.startsWith('remote') };
    },
    async run() {
      calls.push('*');
      return this.status();
    },
  };
  const runtime = {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: null }),
    start: async () => {
      throw new Error('No run expected');
    },
    close: async () => {},
  };
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir,
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime,
    conversationSync: sync,
  });
  await app.store.project({ cwd: other });
  t.after(async () => {
    try {
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, { method = 'GET', body, credential } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, json: await response.json() };
  }
  const enabled = await api('/api/public-api', { method: 'PATCH', body: { enabled: true, revision: 0 } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
  const projectId = (dir) =>
    enabled.json.projects.find((p) => p.cwd === dir || p.name === dir.split(/[\\/]/).pop())?.id;
  async function token(scopes, projectIds = ['*']) {
    const state = await api('/api/public-api');
    const result = await api('/api/public-api/tokens', {
      method: 'POST',
      body: { name: 'sync fixture', scopes, projectIds, revision: state.json.revision },
    });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    return result.json.credential;
  }
  return { api, token, calls, project: projectId(cwd), otherProject: projectId(other) };
}

test('GET /sync exposes state without credentials, bucket URL, errors or session lists', async (t) => {
  const f = await fixture(t);
  const read = await f.token(['read']);
  const result = await f.api('/api/v1/sync', { credential: read });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.json).sort(), ['configured', 'lastSync', 'machineId', 'running']);
  assert.deepEqual(result.json.lastSync, { at: '2026-10-13T12:00:00.000Z', ok: true, sent: 1, received: 2 });
  assert.doesNotMatch(JSON.stringify(result.json), /secret|private-bucket|other-a/);
  const machine = await f.api('/api/v1/machine', { credential: read });
  assert.ok(machine.json.capabilities.includes('sync'));
});

test('POST /projects/{id}/sync requires sync:write and is a no-op without it', async (t) => {
  const f = await fixture(t);
  const read = await f.token(['read', 'runs:write', 'roadmaps:write']);
  const denied = await f.api(`/api/v1/projects/${f.project}/sync`, {
    method: 'POST',
    body: {},
    credential: read,
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(f.calls, []);
});

test('targeted sync receives an unseen conversation and checks membership after receipt', async (t) => {
  const f = await fixture(t);
  assert.ok(f.project && f.otherProject);
  const key = await f.token(['read', 'sync:write']);
  const post = (sessionId, project = f.project) =>
    f.api(`/api/v1/projects/${project}/sync`, { method: 'POST', body: { sessionId }, credential: key });

  const received = await post('remote-new');
  assert.equal(received.status, 200, JSON.stringify(received.json));
  assert.equal(received.json.scope, 'session');
  assert.equal(received.json.sessionId, 'remote-new');
  assert.equal(received.json.changed, true);
  const messages = await f.api('/api/v1/sessions/remote-new/messages', { credential: key });
  assert.equal(messages.status, 200, 'received conversation is readable right away');

  assert.equal((await post('local-a')).status, 200, 'known local conversation syncs');
  assert.equal((await post('other-a')).status, 404, 'known conversation of another project');
  assert.equal(f.calls.includes('other-a'), false, 'nothing synced for a foreign local conversation');
  assert.equal((await post('remote-other')).status, 404, 'received into another project');
  const failed = await post('broken');
  assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.json), /r2\.cloudflarestorage|AKIA/);
  assert.equal((await post('../x')).status, 400);
});

test('full cycle needs a token authorized on every synced project', async (t) => {
  const f = await fixture(t);
  const scoped = await f.token(['read', 'sync:write'], [f.project]);
  const refused = await f.api(`/api/v1/projects/${f.project}/sync`, {
    method: 'POST',
    body: {},
    credential: scoped,
  });
  assert.equal(refused.status, 403);
  assert.equal(f.calls.includes('*'), false);
  const all = await f.token(['read', 'sync:write']);
  const ok = await f.api(`/api/v1/projects/${f.project}/sync`, { method: 'POST', body: {}, credential: all });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.scope, 'all');
  assert.deepEqual(ok.json.lastSync, { at: '2026-10-13T12:00:00.000Z', ok: true, sent: 1, received: 2 });
  assert.deepEqual(f.calls, ['*']);
});

test('sync is refused when not configured', async (t) => {
  const f = await fixture(t, { configured: false });
  const key = await f.token(['read', 'sync:write']);
  const result = await f.api(`/api/v1/projects/${f.project}/sync`, {
    method: 'POST',
    body: { sessionId: 'local-a' },
    credential: key,
  });
  assert.equal(result.status, 409);
  assert.equal(result.json.code ?? result.json.error?.code, 'sync_not_configured');
  assert.deepEqual(f.calls, []);
});
