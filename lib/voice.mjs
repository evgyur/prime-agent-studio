export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_DURATION_MS = 300_000;
export const MAX_TRANSCRIPTION_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 32_000;
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_WHISPER_URL = 'http://127.0.0.1:8080/inference';
const MODELS = new Set(['whisper-large-v3', 'whisper-large-v3-turbo']);
const MIME = new Map([
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/m4a', 'm4a'],
  ['audio/x-m4a', 'm4a'],
]);

const failure = (status, message) => Object.assign(new Error(message), { status });

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  // An early rejection can leave unread upload bytes; close this connection.
  if (status >= 400) res.setHeader('Connection', 'close');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function configuration(env, timeoutOverride) {
  const provider = String(env.PRIME_STUDIO_VOICE_PROVIDER || '')
    .trim()
    .toLowerCase();
  const timeoutValue = env.PRIME_STUDIO_VOICE_TIMEOUT_MS;
  const configuredTimeout = timeoutValue === undefined || timeoutValue === '' ? 90_000 : Number(timeoutValue);
  const timeoutMs = timeoutOverride ?? configuredTimeout;
  const validTimeout =
    Number.isInteger(timeoutMs) &&
    timeoutMs >= (timeoutOverride === undefined ? 1_000 : 1) &&
    timeoutMs <= MAX_TRANSCRIPTION_TIMEOUT_MS;
  const publicStatus = {
    enabled: false,
    provider: provider === 'groq' || provider === 'whisper' ? provider : null,
    maxAudioBytes: MAX_AUDIO_BYTES,
    maxDurationMs: MAX_DURATION_MS,
    timeoutMs: validTimeout ? timeoutMs : 90_000,
  };
  if (!validTimeout) return { publicStatus };
  if (provider === 'groq') {
    const rawKey = String(env.GROQ_API_KEY || '');
    const key = rawKey.trim();
    const model = String(env.PRIME_STUDIO_VOICE_MODEL || 'whisper-large-v3-turbo').trim();
    if (!key || /[\r\n]/.test(rawKey) || !MODELS.has(model)) return { publicStatus };
    publicStatus.enabled = true;
    return { publicStatus, endpoint: GROQ_URL, key, model, timeoutMs };
  }
  if (provider === 'whisper') {
    let endpoint;
    try {
      const rawUrl = String(env.PRIME_STUDIO_WHISPER_URL || DEFAULT_WHISPER_URL);
      const url = new URL(rawUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        rawUrl.includes('?') ||
        rawUrl.includes('#')
      )
        return { publicStatus };
      endpoint = url.href;
    } catch {
      return { publicStatus };
    }
    publicStatus.enabled = true;
    return { publicStatus, endpoint, timeoutMs };
  }
  return { publicStatus };
}

function audioKind(req) {
  const type = String(req.headers['content-type'] || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (!MIME.has(type)) throw failure(415, 'Unsupported audio format.');
  if (req.headers['transfer-encoding'])
    throw failure(411, 'A completed recording with a known size is required.');
  const size = String(req.headers['content-length'] || '');
  if (!/^\d+$/.test(size)) throw failure(411, 'Recording size is missing.');
  if (Number(size) > MAX_AUDIO_BYTES) throw failure(413, 'Recording exceeds 10 MiB.');
  if (Number(size) < 16) throw failure(422, 'Recording is too short or empty.');
  return { type, ext: MIME.get(type), size: Number(size) };
}

function validSignature(data, ext) {
  if (ext === 'webm') return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (ext === 'ogg') return data.subarray(0, 4).toString() === 'OggS';
  return data.subarray(4, 8).toString() === 'ftyp';
}

async function boundedJson(response, signal) {
  if (!response.body) throw failure(502, 'Transcription service returned an empty response.');
  const reader = response.body.getReader();
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  if (signal.aborted) cancelOnAbort();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw failure(502, 'Transcription response is too large.');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.status) throw error;
    throw failure(502, 'Could not read the transcription response.');
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
}

/** Mount behind Studio's Host, Origin, and CSRF checks. Audio is memory-only. */
export function createVoice({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  const config = configuration(env, timeoutMs);
  let busy = false;
  async function transcribe(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'Upload a recording with POST.' });
    }
    if (!config.publicStatus.enabled) return json(res, 503, { error: 'Transcription is unavailable.' });
    if (busy) return json(res, 429, { error: 'Another recording is being transcribed. Try again shortly.' });
    const abort = new AbortController();
    let timer, audio;
    const disconnect = () => abort.abort();
    const close = () => {
      if (!res.writableEnded) abort.abort();
    };
    let ownsBusy = false;
    try {
      const kind = audioKind(req);
      busy = true;
      ownsBusy = true;
      req.once('aborted', disconnect);
      res.once('close', close);
      timer = setTimeout(() => {
        abort.abort();
        if (!req.complete) req.destroy();
      }, config.timeoutMs);
      timer.unref?.();
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        if (abort.signal.aborted) throw failure(408, 'Recording upload timed out.');
        length += chunk.length;
        if (length > MAX_AUDIO_BYTES) throw failure(413, 'Recording exceeds 10 MiB.');
        chunks.push(chunk);
      }
      if (length !== kind.size) throw failure(400, 'Recording upload was incomplete. Try again.');
      audio = Buffer.concat(chunks);
      if (!validSignature(audio, kind.ext)) throw failure(422, 'Could not read the audio recording.');
      const body = new FormData();
      body.set('file', new Blob([audio], { type: kind.type }), `voice.${kind.ext}`);
      body.set('response_format', 'json');
      if (config.model) body.set('model', config.model);
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        ...(config.key ? { headers: { Authorization: `Bearer ${config.key}` } } : {}),
        body,
        signal: abort.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) throw failure(429, 'Transcription rate limit reached. Try again later.');
        if ([400, 413, 415, 422].includes(response.status))
          throw failure(422, 'The service could not transcribe this recording. Try recording again.');
        throw failure(503, 'Transcription is unavailable. Try sending the recording again.');
      }
      const result = await boundedJson(response, abort.signal);
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string')
        throw failure(502, 'Invalid transcription response.');
      const transcript = result.text.trim();
      if (!transcript) throw failure(422, 'No speech was recognized. Try recording again.');
      if (transcript.length > MAX_TRANSCRIPT_CHARS)
        throw failure(422, 'Transcript is too long. Split the recording.');
      return json(res, 200, { text: transcript });
    } catch (error) {
      const status = abort.signal.aborted ? 504 : error.status || 503;
      return json(res, status, {
        error: abort.signal.aborted
          ? 'Transcription timed out. Try sending the recording again.'
          : error.status
            ? error.message
            : 'Transcription is unavailable. Try sending the recording again.',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', disconnect);
      res.off('close', close);
      if (audio) audio.fill(0);
      if (ownsBusy) busy = false;
    }
  }
  return { status: () => ({ ...config.publicStatus }), transcribe };
}
