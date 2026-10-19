import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRemoteAccess } from '../lib/remote-access.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { createApp } from '../server.mjs';
const oldCode = '12345678',
  newCode = '01234567';
const config = () => ({
  enabled: true,
  host: '192.168.86.35',
  port: 3089,
  readOnly: false,
  salt: 'a'.repeat(32),
  codeHash: hashAccessCode(oldCode, 'a'.repeat(32)),
  tailscale: {
    enabled: true,
    host: '100.80.1.2',
    https: { enabled: true, origin: 'https://studio.example.ts.net', port: 3090 },
  },
  custom: { preserve: true },
});
async function fixture(t, initial = config()) {
  const dataDir = await mkdtemp(join(tmpdir(), 'prime-remote-code-'));
  const access = createRemoteAccess({ dataDir });
  const cleanup = [];
  if (initial) await writeFile(access.file, JSON.stringify(initial));
  t.after(async () => {
    // Release SQLite handles before deleting their directory on Windows.
    for (const close of cleanup) await close();
    assert.equal(dirname(dataDir), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dataDir, access, cleanup };
}
function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('error', reject);
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
test('PIN rotation stores a salted hash, preserves network configuration and rejects stale or invalid changes', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.access.file, 'utf8');
  let state = await f.access.get();
  assert.deepEqual(Object.keys(state), ['configured', 'enabled', 'revision']);
  assert.doesNotMatch(JSON.stringify(state), /codeHash|salt|12345678/);
  for (const body of [
    { code: '1234', confirmation: '1234' },
    { code: '12a45678', confirmation: '12a45678' },
    { code: newCode, confirmation: oldCode },
    { code: newCode, confirmation: newCode, extra: true },
  ])
    await assert.rejects(f.access.changeCode({ revision: state.revision, ...body }), { status: 400 });
  assert.equal(await readFile(f.access.file, 'utf8'), before);
  const result = await f.access.changeCode({
    revision: state.revision,
    code: newCode,
    confirmation: newCode,
  });
  assert.deepEqual(result, { updated: true, reconnectRequired: true });
  const saved = JSON.parse(await readFile(f.access.file, 'utf8'));
  assert.notEqual(saved.salt, config().salt);
  assert.equal(saved.codeHash, hashAccessCode(newCode, saved.salt));
  assert.deepEqual({ ...saved, salt: '', codeHash: '' }, { ...config(), salt: '', codeHash: '' });
  assert.ok(!(await readFile(f.access.file, 'utf8')).includes(newCode));
  await assert.rejects(
    f.access.changeCode({ revision: state.revision, code: oldCode, confirmation: oldCode }),
    { status: 409 },
  );
  state = await f.access.get();
  await writeFile(f.access.file, '{broken');
  await assert.rejects(
    f.access.changeCode({ revision: state.revision, code: oldCode, confirmation: oldCode }),
    { status: 500 },
  );
  assert.equal(await readFile(f.access.file, 'utf8'), '{broken');
});
test('an unconfigured mobile access stays disabled and never gains network listeners by changing a code', async (t) => {
  const f = await fixture(t, null);
  assert.deepEqual(await f.access.get(), { configured: false, enabled: false, revision: null });
  await assert.rejects(
    f.access.changeCode({ revision: 'a'.repeat(64), code: newCode, confirmation: newCode }),
    { status: 409 },
  );
});
test('changing the PIN revokes all LAN/Tailscale/PWA cookies and streams immediately, including slow writes, while agents keep running', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.dataDir, 'project'),
    sessionDir = join(f.dataDir, 'sessions');
  await mkdir(cwd);
  await mkdir(sessionDir);
  let cancellations = 0,
    finish;
  const runtime = {
    getStatus: async () => ({ available: true }),
    getModels: async () => ({ models: [] }),
    start: async () => ({
      done: new Promise((done) => {
        finish = done;
      }),
      cancel: async () => {
        cancellations++;
        finish({ status: 'stopped', code: 130 });
      },
    }),
    close: async () => finish?.({ status: 'completed', code: 0 }),
  };
  const app = createApp({
    dataDir: f.dataDir,
    sessionDir,
    agentHome: join(f.dataDir, 'agent'),
    initialCwd: cwd,
    runtime,
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  f.cleanup.push(() => app.close());
  const port = app.server.address().port;
  const local = (path, body) =>
    http(
      port,
      path,
      body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {},
    );
  const started = await local('/api/runs', { cwd, message: 'Keep working' });
  assert.equal(started.status, 201);
  const remotes = [];
  for (const options of [
    { host: config().host },
    { host: config().tailscale.host },
    { host: '127.0.0.1', publicOrigin: config().tailscale.https.origin },
  ]) {
    const gateway = createLanGateway({ ...options, upstreamPort: port, config: config() });
    await app.remoteAccess.registerGateway(gateway);
    await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
    t.after(async () => {
      gateway.closeAllConnections();
      await new Promise((done) => gateway.close(done));
    });
    const gatewayPort = gateway.address().port;
    const headers = {
      Host: options.publicOrigin ? new URL(options.publicOrigin).host : `${options.host}:${gatewayPort}`,
    };
    const api = (path, more = {}) =>
      http(gatewayPort, path, { ...more, headers: { ...headers, ...more.headers } });
    const login = (code) =>
      api('/lan/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `code=${code}`,
      });
    const signedIn = await login(oldCode);
    assert.equal(signedIn.status, 303);
    const cookie = signedIn.headers['set-cookie'][0].split(';')[0];
    const stream = await new Promise((done, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: gatewayPort,
          path: `/api/runs/${started.json.id}/events`,
          headers: { ...headers, Cookie: cookie },
        },
        (res) => {
          res.resume();
          res.on('error', () => {});
          done(res);
        },
      );
      req.on('error', reject);
      req.end();
    });
    const closed = new Promise((done) => stream.once('close', done));
    // Full control reaches remote-access management (consultation stays blocked, covered in lan tests).
    assert.equal((await api('/api/remote-access', { headers: { Cookie: cookie } })).status, 200);
    assert.notEqual(
      (
        await api('/api/remote-access/code', {
          method: 'POST',
          body: '{}',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        })
      ).status,
      404,
    );
    remotes.push({ api, cookie, closed, login, gateway, gatewayPort, headers });
  }
  const first = remotes[0],
    payload = JSON.stringify({ cwd });
  let slow;
  const requestSeen = new Promise((done) => first.gateway.once('request', done));
  const slowResponse = new Promise((done, reject) => {
    slow = request(
      {
        hostname: '127.0.0.1',
        port: first.gatewayPort,
        path: '/api/projects',
        method: 'POST',
        headers: {
          ...first.headers,
          Cookie: first.cookie,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode));
      },
    );
    slow.on('error', reject);
    slow.write(payload.slice(0, 1));
  });
  await requestSeen;
  const state = (await local('/api/remote-access')).json;
  assert.equal(
    (
      await local('/api/remote-access/code', {
        revision: state.revision,
        code: newCode,
        confirmation: newCode,
      })
    ).status,
    200,
  );
  slow.end(payload.slice(1));
  assert.equal(await slowResponse, 401);
  await Promise.race([
    Promise.all(remotes.map((r) => r.closed)),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Streams not revoked')), 2500);
      timer.unref();
    }),
  ]);
  for (const remote of remotes) {
    assert.equal((await remote.api('/api/runs', { headers: { Cookie: remote.cookie } })).status, 401);
    assert.equal((await remote.login(oldCode)).status, 401);
    assert.equal((await remote.login(newCode)).status, 303);
  }
  assert.equal(cancellations, 0);
  assert.equal((await local('/api/runs')).json.runs.length, 1);
  // A listener created later also sees the persisted code, even if its startup snapshot was old.
  const later = createLanGateway({ host: '127.0.0.1', upstreamPort: port, config: config() });
  await app.remoteAccess.registerGateway(later);
  await new Promise((done) => later.listen(0, '127.0.0.1', done));
  t.after(async () => {
    later.closeAllConnections();
    await new Promise((done) => later.close(done));
  });
  assert.equal(
    (
      await http(later.address().port, '/lan/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `code=${newCode}`,
      })
    ).status,
    303,
  );
});
