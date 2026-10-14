import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createVoice, MAX_AUDIO_BYTES, MAX_DURATION_MS } from '../lib/voice.mjs';

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const groq = { PRIME_STUDIO_VOICE_PROVIDER: 'groq', GROQ_API_KEY: 'fixture-token' };

async function fixture(t, options = {}) {
  const calls = [];
  const voice = createVoice({
    env: groq,
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

test('opt-in status exposes only public limits and disabled or invalid config never calls provider', async (t) => {
  for (const env of [
    {},
    { ...groq, GROQ_API_KEY: '' },
    { ...groq, GROQ_API_KEY: 'fixture-token\n' },
    { ...groq, PRIME_STUDIO_VOICE_MODEL: 'custom-model' },
    { ...groq, PRIME_STUDIO_VOICE_TIMEOUT_MS: '999' },
    { PRIME_STUDIO_VOICE_PROVIDER: 'other' },
    { PRIME_STUDIO_VOICE_PROVIDER: 'whisper', PRIME_STUDIO_WHISPER_URL: 'ftp://internal/inference' },
    {
      PRIME_STUDIO_VOICE_PROVIDER: 'whisper',
      PRIME_STUDIO_WHISPER_URL: 'http://user:secret@internal/inference',
    },
    {
      PRIME_STUDIO_VOICE_PROVIDER: 'whisper',
      PRIME_STUDIO_WHISPER_URL: 'http://internal/inference?token=secret',
    },
    { PRIME_STUDIO_VOICE_PROVIDER: 'whisper', PRIME_STUDIO_WHISPER_URL: 'http://internal/inference?' },
    { PRIME_STUDIO_VOICE_PROVIDER: 'whisper', PRIME_STUDIO_WHISPER_URL: 'http://internal/inference#' },
  ]) {
    const { calls, voice, url } = await fixture(t, { env });
    assert.equal(voice.status().enabled, false);
    const response = await upload(url);
    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(
      JSON.stringify(voice.status()) + (await response.text()),
      /secret|fixture-token|internal|GROQ_API_KEY/,
    );
  }
  const status = createVoice({ env: groq }).status();
  assert.deepEqual(status, {
    enabled: true,
    provider: 'groq',
    maxAudioBytes: MAX_AUDIO_BYTES,
    maxDurationMs: MAX_DURATION_MS,
    timeoutMs: 90_000,
  });
});

test('Groq uses fixed endpoint, selected allowlisted model, multipart audio, and only server credential', async (t) => {
  const { url, calls } = await fixture(t, { env: { ...groq, PRIME_STUDIO_VOICE_MODEL: 'whisper-large-v3' } });
  const response = await upload(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Check the current project.' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 1);
  const { url: upstream, init } = calls[0];
  assert.equal(upstream, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(init.headers.Authorization, 'Bearer fixture-token');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body.get('model'), 'whisper-large-v3');
  assert.equal(init.body.get('response_format'), 'json');
  assert.equal(init.body.get('file').name, 'voice.webm');
  assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), webm);
});

test('Whisper sends complete admin endpoint without Groq key or model', async (t) => {
  const endpoint = 'http://127.0.0.1:8080/inference';
  const { url, calls, voice } = await fixture(t, {
    env: {
      PRIME_STUDIO_VOICE_PROVIDER: 'whisper',
      PRIME_STUDIO_WHISPER_URL: endpoint,
      GROQ_API_KEY: 'secret-key',
      PRIME_STUDIO_VOICE_MODEL: 'secret-model',
    },
  });
  assert.equal((await upload(url)).status, 200);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[0].init.body.get('model'), null);
  assert.equal(calls[0].init.body.get('response_format'), 'json');
  assert.doesNotMatch(JSON.stringify(voice.status()), /secret|inference|127\.0\.0\.1/);
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
  for (const [response, expected] of [
    [new Response('secret-service-error', { status: 403 }), 503],
    [new Response('secret-token', { status: 429 }), 429],
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
  assert.equal((await upload(url)).status, 429);
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
  // The module has no filesystem or process imports; this test exercises its in-memory route.
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
