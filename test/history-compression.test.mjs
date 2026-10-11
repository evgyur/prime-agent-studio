import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

// Varied word-list text: realistic gzip behavior, no repeated-char artifacts.
let seed = 1234;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const words =
  'the quick brown fox jumps over lazy dog prime agent session tool result shell output error code reason model token stream render mobile network latency cache server history overview branch message thought'.split(
    ' ',
  );
const varied = (n) => Array.from({ length: n }, () => words[(rnd() * words.length) | 0]).join(' ');
const message = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-09-04T00:01:00.000Z',
  message: { role, content, ...extra },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-history-gzip-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'local');
  const agentHome = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentHome)]);
  const writeSession = async (id, entries) => {
    await writeFile(
      join(sessionDir, `${id}.jsonl`),
      [{ type: 'session', id, cwd, timestamp: '2026-09-04T00:00:00.000Z' }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
  };
  await writeSession('small-session', [message('m1', null, 'user', 'Hello, short note.')]);
  const big = [];
  let parent = null;
  for (let m = 0; m < 100; m++) {
    const mid = `big-${m}`;
    if (m % 2 === 0) {
      big.push(message(mid, parent, 'user', varied(60)));
      parent = mid;
    } else {
      big.push(
        message(
          mid,
          parent,
          'assistant',
          [
            { type: 'text', text: varied(200) },
            { type: 'toolCall', id: `tool-${m}`, name: 'shell', arguments: { command: varied(8) } },
          ],
          {},
        ),
      );
      big.push(
        message(mid + 'r', mid, 'toolResult', varied(300), {
          toolCallId: `tool-${m}`,
          toolName: 'shell',
        }),
      );
      parent = `${mid}r`;
    }
  }
  await writeSession('large-session', big);
  // Bytes > 2048 but chars < 2048: nails the byte (not char) gzip threshold.
  await writeSession('unicode-session', [message('u1', null, 'user', '€'.repeat(1000))]);
  const runtime = {
    async getStatus() {
      return { available: false, version: null };
    },
    async getModels() {
      return { models: [], default: null };
    },
    async close() {},
  };
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: cwd, runtime });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function raw(path, { headers = {} } = {}) {
    return new Promise((done, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  }
  return { raw };
}

test('gzip history is byte-identical after gunzip and leaves history intact', async (t) => {
  const f = await fixture(t);
  const identity = await f.raw('/api/history?id=large-session');
  const compressed = await f.raw('/api/history?id=large-session', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(identity.status, 200);
  assert.equal(compressed.status, 200);
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(compressed.headers.vary || '', /accept-encoding/i);
  assert.equal(compressed.headers['cache-control'], 'no-store');
  assert.equal(compressed.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(compressed.body.length < identity.body.length, 'gzip must shrink a large text history');
  assert.deepEqual(gunzipSync(compressed.body), identity.body);
  const fromGzip = JSON.parse(gunzipSync(compressed.body).toString('utf8'));
  const fromIdentity = JSON.parse(identity.body.toString('utf8'));
  assert.deepEqual(fromGzip, fromIdentity);
  assert.ok(fromGzip.messages.length >= 100, 'all history messages preserved');
  assert.equal(fromGzip.id, 'large-session');
  const withResult = fromGzip.messages.flatMap((m) => m.tools || []).filter((t) => t.result);
  assert.equal(withResult.length, 50, 'every toolResult kept on-branch with its result');
});

test('unicode payload over the byte threshold compresses despite fewer chars', async (t) => {
  const f = await fixture(t);
  const identity = await f.raw('/api/history?id=unicode-session');
  assert.equal(identity.status, 200);
  const text = identity.body.toString('utf8');
  assert.ok(text.length < 2048, `chars stay under threshold: ${text.length}`);
  assert.ok(Buffer.byteLength(text) > 2048, `bytes exceed threshold: ${Buffer.byteLength(text)}`);
  const compressed = await f.raw('/api/history?id=unicode-session', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(compressed.body), identity.body);
  assert.equal(JSON.parse(gunzipSync(compressed.body).toString('utf8')).messages[0].text, '€'.repeat(1000));
});

test('missing, identity, refused or zero-quality encodings stay identity', async (t) => {
  const f = await fixture(t);
  for (const headers of [
    {},
    { 'Accept-Encoding': 'identity' },
    { 'Accept-Encoding': 'gzip;q=0' },
    { 'Accept-Encoding': 'gzip; q=0, deflate' },
    { 'Accept-Encoding': 'br' },
    { 'Accept-Encoding': '*;q=0' },
    { 'Accept-Encoding': 'gzip;q=0, *;q=1' },
    { 'Accept-Encoding': 'gzip;q=0.0' },
  ]) {
    const response = await f.raw('/api/history?id=large-session', { headers });
    assert.equal(response.status, 200, JSON.stringify(headers));
    assert.equal(response.headers['content-encoding'], undefined, JSON.stringify(headers));
    assert.ok(JSON.parse(response.body.toString('utf8')).messages.length >= 100);
  }
  const star = await f.raw('/api/history?id=large-session', { headers: { 'Accept-Encoding': '*' } });
  assert.equal(star.headers['content-encoding'], 'gzip');
  const plain = await f.raw('/api/history?id=large-session');
  assert.deepEqual(gunzipSync(star.body), plain.body);
  for (const headers of [{ 'Accept-Encoding': 'GZip' }, { 'Accept-Encoding': 'gzip;q=0.5' }]) {
    const response = await f.raw('/api/history?id=large-session', { headers });
    assert.equal(response.status, 200, JSON.stringify(headers));
    assert.equal(response.headers['content-encoding'], 'gzip', JSON.stringify(headers));
    assert.deepEqual(gunzipSync(response.body), plain.body, JSON.stringify(headers));
  }
});

test('small history is never compressed', async (t) => {
  const f = await fixture(t);
  const response = await f.raw('/api/history?id=small-session', {
    headers: { 'Accept-Encoding': 'gzip, deflate, br' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  const body = JSON.parse(response.body.toString('utf8'));
  assert.equal(body.id, 'small-session');
  assert.equal(body.messages[0].text, 'Hello, short note.');
});

test('unknown id, bearer rejection and other routes are unchanged by Accept-Encoding', async (t) => {
  const f = await fixture(t);
  const missingPlain = await f.raw('/api/history?id=no-such-session');
  const missingGzip = await f.raw('/api/history?id=no-such-session', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(missingPlain.status, 404);
  assert.equal(missingGzip.status, 404);
  assert.equal(missingGzip.headers['content-encoding'], undefined);
  assert.deepEqual(missingGzip.body, missingPlain.body);
  const bearerPlain = await f.raw('/api/history?id=large-session', {
    headers: { Authorization: 'Bearer secret' },
  });
  const bearerGzip = await f.raw('/api/history?id=large-session', {
    headers: { Authorization: 'Bearer secret', 'Accept-Encoding': 'gzip' },
  });
  assert.equal(bearerPlain.status, 401);
  assert.deepEqual(bearerGzip.body, bearerPlain.body);
  assert.equal(bearerGzip.headers['content-encoding'], undefined);
  const overview = await f.raw('/api/overview', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(overview.status, 200);
  assert.equal(overview.headers['content-encoding'], undefined);
  const health = await f.raw('/api/health', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(health.status, 200);
  assert.equal(health.headers['content-encoding'], undefined);
});
