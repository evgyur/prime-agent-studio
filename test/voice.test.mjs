import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoice, MAX_AUDIO_BYTES, MAX_DURATION_MS, DEFAULT_WHISPER_URL } from '../lib/voice.mjs';

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const groqAuth = { groq: { type: 'api_key', key: 'fixture-token' } };

async function dirs(t, { settings = { provider: 'groq' }, auth = groqAuth } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-voice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (settings) await writeFile(join(root, 'voice.json'), JSON.stringify(settings));
  if (auth) await writeFile(join(root, 'auth.json'), JSON.stringify(auth));
  return { dataDir: root, agentHome: root };
}

async function fixture(t, options = {}) {
  const calls = [];
  const voice = createVoice({
    ...(await dirs(t, options)),
    env: {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ text: 'Check the current project.' });
    },
    ...options,
  });
  const server = createServer((req, res) => {
    voice.transcribe(req, res);
    options.onRequest?.(req);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { calls, voice, url: `http://127.0.0.1:${server.address().port}` };
}

const upload = (url, opts = {}) =>
  fetch(url, {
    method: 'POST',
    body: webm,
    headers: { 'Content-Type': 'audio/webm;codecs=opus' },
    ...opts,
  });

test('disabled, keyless or invalid configuration never calls the provider and leaks nothing', async (t) => {
  for (const [settings, auth, env, reason] of [
    [null, groqAuth, {}, 'not_configured'],
    [{ provider: 'other' }, groqAuth, {}, 'not_configured'],
    [{ provider: 'groq' }, null, {}, 'missing_key'],
    [{ provider: 'groq' }, { groq: { type: 'api_key', key: '' } }, {}, 'missing_key'],
    [{ provider: 'groq' }, { groq: { type: 'api_key', key: '!cat secret' } }, {}, 'missing_key'],
    [{ provider: 'groq' }, { groq: { type: 'oauth', access: 'secret' } }, {}, 'missing_key'],
    [{ provider: 'groq' }, null, { GROQ_API_KEY: 'secret\n' }, 'missing_key'],
  ]) {
    const { calls, voice, url } = await fixture(t, { settings, auth, env });
    const status = await voice.status();
    assert.equal(status.enabled, false);
    assert.equal(status.reason, reason);
    const response = await upload(url);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, reason);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(JSON.stringify(status), /secret|fixture-token/);
  }
  const { voice } = await fixture(t);
  assert.deepEqual(await voice.status(), {
    enabled: true,
    provider: 'groq',
    reason: null,
    maxAudioBytes: MAX_AUDIO_BYTES,
    maxDurationMs: MAX_DURATION_MS,
    timeoutMs: 90_000,
  });
});

test('Groq reuses the Providers key first, then GROQ_API_KEY, with the selected model', async (t) => {
  const { url, calls, voice } = await fixture(t, {
    settings: { provider: 'groq', groqModel: 'whisper-large-v3' },
    env: { GROQ_API_KEY: 'environment-token' },
  });
  const response = await upload(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Check the current project.' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { url: upstream, init } = calls[0];
  assert.equal(upstream, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(init.headers.Authorization, 'Bearer fixture-token');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body.get('model'), 'whisper-large-v3');
  assert.equal(init.body.get('response_format'), 'json');
  assert.equal(init.body.get('file').name, 'voice.webm');
  assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), webm);
  assert.equal((await voice.settings()).keySource, 'providers');
  assert.doesNotMatch(JSON.stringify(await voice.settings()), /token/);

  const env = await fixture(t, { auth: null, env: { GROQ_API_KEY: 'environment-token' } });
  assert.equal((await upload(env.url)).status, 200);
  assert.equal(env.calls[0].init.headers.Authorization, 'Bearer environment-token');
  assert.equal(env.calls[0].init.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal((await env.voice.settings()).keySource, 'environment');

  const named = await fixture(t, {
    auth: { groq: { type: 'api_key', key: 'MY_GROQ_KEY' } },
    env: { MY_GROQ_KEY: 'named-token' },
  });
  assert.equal((await upload(named.url)).status, 200);
  assert.equal(named.calls[0].init.headers.Authorization, 'Bearer named-token');
});

test('Whisper sends the configured endpoint without Groq key or model', async (t) => {
  const endpoint = 'http://127.0.0.1:8181/inference';
  const { url, calls, voice } = await fixture(t, {
    settings: { provider: 'whisper', whisperUrl: endpoint, groqModel: 'whisper-large-v3' },
  });
  assert.equal((await upload(url)).status, 200);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[0].init.body.get('model'), null);
  assert.doesNotMatch(JSON.stringify(await voice.status()), /inference|8181|fixture-token/);
  assert.equal((await voice.settings()).whisperUrl, endpoint);
});

test('settings validate, persist machine-locally and never return the key', async (t) => {
  const { voice } = await fixture(t, { settings: null });
  const initial = await voice.settings();
  assert.equal(initial.provider, '');
  assert.equal(initial.whisperUrl, DEFAULT_WHISPER_URL);
  assert.equal(initial.status.reason, 'not_configured');
  for (const patch of [
    {},
    null,
    [],
    { provider: 'openai' },
    { groqModel: 'custom' },
    { timeoutMs: 1234 },
    { whisperUrl: 'ftp://internal/inference' },
    { whisperUrl: 'http://user:secret@internal/inference' },
    { whisperUrl: 'http://internal/inference?token=secret' },
    { whisperUrl: 'http://internal/inference#x' },
    { key: 'fixture-token' },
  ])
    await assert.rejects(voice.updateSettings(patch), (error) => error.status === 400);
  const saved = await voice.updateSettings({ provider: 'groq', timeoutMs: 300_000 });
  assert.equal(saved.provider, 'groq');
  assert.equal(saved.timeoutMs, 300_000);
  assert.equal(saved.status.enabled, true);
  assert.equal(saved.keySource, 'providers');
  assert.doesNotMatch(JSON.stringify(saved), /fixture-token/);
  await voice.updateSettings({ provider: 'whisper', whisperUrl: 'https://whisper.lan/inference' });
  const stored = await voice.settings();
  assert.equal(stored.provider, 'whisper');
  assert.equal(stored.whisperUrl, 'https://whisper.lan/inference');
  assert.equal(stored.timeoutMs, 300_000);
});

test('rejects method, MIME, invalid signatures, declared oversize, and chunked upload before provider', async (t) => {
  const { url, calls } = await fixture(t);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await upload(url, { headers: { 'Content-Type': 'text/html' } })).status, 415);
  assert.equal((await upload(url, { body: Buffer.alloc(32) })).status, 422);
  assert.equal((await upload(url, { body: Buffer.alloc(0) })).status, 422);
  async function raw(headers) {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  }
  assert.equal(await raw({ 'Content-Type': 'audio/webm', 'Content-Length': MAX_AUDIO_BYTES + 1 }), 413);
  assert.equal(await raw({ 'Content-Type': 'audio/webm', 'Transfer-Encoding': 'chunked' }), 411);
  assert.equal(calls.length, 0);
});

test('accepts browser Ogg and MP4 signatures', async (t) => {
  const { url } = await fixture(t);
  for (const [type, body] of [
    ['audio/ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)])],
    ['audio/mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(32)])],
  ])
    assert.equal((await upload(url, { body, headers: { 'Content-Type': type } })).status, 200);
});

test('sanitizes provider errors, bounds response and transcript, and refuses silence', async (t) => {
  for (const [response, expected, code] of [
    [new Response('secret-service-error', { status: 403 }), 503, 'auth_failed'],
    [new Response('secret-token', { status: 429 }), 429, 'rate_limited'],
    [new Response('secret-busy', { status: 500 }), 503, 'unavailable'],
    [new Response('secret-format', { status: 400 }), 422, 'unreadable'],
    [Response.json({ text: '  ' }), 422],
    [new Response('invalid secret-json'), 502],
    [Response.json(null), 502],
    [Response.json([]), 502],
    [Response.json({ text: 42 }), 502],
    [Response.json({ text: 'x'.repeat(32_001) }), 422],
    [Response.json({ text: 'x'.repeat(MAX_AUDIO_BYTES) }), 502],
  ]) {
    const { url } = await fixture(t, { fetchImpl: async () => response });
    const result = await upload(url);
    assert.equal(result.status, expected);
    const payload = await result.json();
    assert.ok(payload.error);
    if (code) assert.equal(payload.code, code);
    assert.equal(payload.text, undefined);
    assert.doesNotMatch(payload.error, /secret|token/);
    assert.doesNotMatch(payload.error, /[\u0400-\u04ff]/);
  }
});

test('timeout cancels a stalled provider response body and releases the slot', async (t) => {
  let calls = 0;
  let cancelled = false;
  const { url } = await fixture(t, {
    timeoutMs: 30,
    fetchImpl: async () => {
      if (calls++ > 0) return Response.json({ text: 'Recovered' });
      return new Response(
        new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel: () => {
            cancelled = true;
          },
        }),
      );
    },
  });
  assert.equal((await upload(url)).status, 504);
  assert.equal(cancelled, true);
  assert.equal((await upload(url)).status, 200);
});

test('one request at a time, timeout aborts provider, and slot is released', async (t) => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { url } = await fixture(t, {
    fetchImpl: async () => {
      entered();
      await pending;
      return Response.json({ text: 'test' });
    },
  });
  const first = upload(url);
  await started;
  const busy = await upload(url);
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).code, 'busy');
  release();
  assert.equal((await first).status, 200);
  assert.equal((await upload(url)).status, 200);
  let aborted = false;
  const timed = await fixture(t, {
    timeoutMs: 30,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('secret abort'));
          },
          { once: true },
        );
      }),
  });
  assert.equal((await upload(timed.url)).status, 504);
  assert.equal(aborted, true);
});

test('client disconnect aborts upstream without persisting audio', async (t) => {
  let entered, aborted;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const ended = new Promise((resolve) => {
    aborted = resolve;
  });
  const { url } = await fixture(t, {
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener(
          'abort',
          () => {
            aborted();
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  });
  const controller = new AbortController();
  const response = upload(url, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(response);
  await ended;
  // Audio stays in memory: only voice.json and auth.json are ever read.
});

test('aborted upload never calls provider and releases the slot', async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { url, calls } = await fixture(t, {
    onRequest: (req) => {
      if (req.headers['x-test-hold']) entered();
    },
  });
  const req = request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm', 'Content-Length': webm.length, 'X-Test-Hold': '1' },
  });
  req.on('error', () => {});
  req.write(webm.subarray(0, 20));
  await started;
  assert.equal((await upload(url)).status, 429);
  req.destroy();
  await new Promise((resolve) => req.once('close', resolve));
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    result = await upload(url);
    if (result.status === 200) break;
    assert.equal(result.status, 429);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
});
