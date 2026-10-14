import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_DURATION_MS = 300_000;
export const MAX_TRANSCRIPTION_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 32_000;
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const DEFAULT_WHISPER_URL = 'http://127.0.0.1:8080/inference';
export const VOICE_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
export const VOICE_TIMEOUTS = [30_000, 90_000, 180_000, 300_000, 600_000];
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  provider: '',
  groqModel: 'whisper-large-v3-turbo',
  whisperUrl: DEFAULT_WHISPER_URL,
  timeoutMs: 90_000,
});
const MIME = new Map([
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/m4a', 'm4a'],
  ['audio/x-m4a', 'm4a'],
]);

const failure = (status, message, code) => Object.assign(new Error(message), { status, code });
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

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

// The endpoint must be a complete transcription URL without credentials,
// query or fragment: the server never forwards them and never follows redirects.
export function validWhisperUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\s?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function normalizeSettings(value) {
  const stored = record(value) ? value : {};
  return {
    provider: ['groq', 'whisper'].includes(stored.provider) ? stored.provider : '',
    groqModel: VOICE_MODELS.includes(stored.groqModel) ? stored.groqModel : DEFAULT_VOICE_SETTINGS.groqModel,
    whisperUrl: validWhisperUrl(stored.whisperUrl) ? stored.whisperUrl : DEFAULT_WHISPER_URL,
    timeoutMs: VOICE_TIMEOUTS.includes(stored.timeoutMs)
      ? stored.timeoutMs
      : DEFAULT_VOICE_SETTINGS.timeoutMs,
  };
}

export function validateVoicePatch(patch) {
  const keys = record(patch) ? Object.keys(patch) : [];
  const invalid = () => failure(400, 'Invalid voice settings.', 'voice_settings_invalid');
  if (!keys.length || keys.some((key) => !(key in DEFAULT_VOICE_SETTINGS))) throw invalid();
  if ('provider' in patch && !['', 'groq', 'whisper'].includes(patch.provider)) throw invalid();
  if ('groqModel' in patch && !VOICE_MODELS.includes(patch.groqModel)) throw invalid();
  if ('timeoutMs' in patch && !VOICE_TIMEOUTS.includes(patch.timeoutMs)) throw invalid();
  if ('whisperUrl' in patch && !validWhisperUrl(patch.whisperUrl))
    throw failure(
      400,
      'Enter a complete http(s) transcription URL without credentials or query.',
      'voice_url_invalid',
    );
  return patch;
}

// Same key as the Groq model provider (Preferences > Providers), with Prime
// Agent's precedence: auth.json first, then GROQ_API_KEY. A stored value
// naming an environment variable resolves to it; shell commands are not run.
async function groqKey(agentHome, env) {
  // A usable key is one header-safe token: no inner whitespace or line break.
  const usable = (value) => (typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) ? value : null);
  let stored;
  try {
    const auth = JSON.parse(await readFile(join(agentHome, 'auth.json'), 'utf8'));
    if (record(auth?.groq) && auth.groq.type === 'api_key') stored = usable(auth.groq.key?.trim?.());
  } catch {}
  if (stored && !stored.startsWith('!')) {
    const named =
      /^[A-Z_][A-Z0-9_]*$/.test(stored) && env[stored] !== undefined ? usable(env[stored]) : stored;
    if (named) return { key: named, source: 'providers' };
  }
  const key = usable(env.GROQ_API_KEY);
  return key ? { key, source: 'environment' } : null;
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

async function readSettings(file) {
  try {
    return normalizeSettings(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return normalizeSettings(null);
  }
}

/** Mount behind Studio's Host, Origin, and CSRF checks. Audio is memory-only. */
export function createVoice({
  dataDir,
  agentHome,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  // Machine-local: never part of synced Studio preferences (the Whisper URL
  // usually names this PC's loopback).
  const file = dataDir ? join(dataDir, 'voice.json') : null;
  let busy = false;
  let writes = Promise.resolve();

  async function configuration() {
    const settings = file ? await readSettings(file) : normalizeSettings(null);
    const publicStatus = {
      enabled: false,
      provider: settings.provider || null,
      reason: settings.provider ? null : 'not_configured',
      maxAudioBytes: MAX_AUDIO_BYTES,
      maxDurationMs: MAX_DURATION_MS,
      timeoutMs: timeoutMs ?? settings.timeoutMs,
    };
    let credential = null;
    if (settings.provider === 'groq') {
      credential = agentHome ? await groqKey(agentHome, env) : null;
      if (!credential) publicStatus.reason = 'missing_key';
    }
    if (settings.provider === 'whisper' || credential) {
      publicStatus.enabled = true;
      publicStatus.reason = null;
    }
    return {
      settings,
      publicStatus,
      keySource: credential?.source || null,
      endpoint: settings.provider === 'groq' ? GROQ_URL : settings.whisperUrl,
      key: credential?.key,
      model: settings.provider === 'groq' ? settings.groqModel : undefined,
      timeoutMs: publicStatus.timeoutMs,
    };
  }

  async function transcribe(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'Upload a recording with POST.' });
    }
    if (busy)
      return json(res, 429, {
        error: 'Another recording is being transcribed. Try again shortly.',
        code: 'busy',
      });
    busy = true;
    const abort = new AbortController();
    let timer, audio;
    const disconnect = () => abort.abort();
    const close = () => {
      if (!res.writableEnded) abort.abort();
    };
    try {
      const config = await configuration();
      if (!config.publicStatus.enabled)
        throw failure(503, 'Transcription is unavailable.', config.publicStatus.reason);
      const kind = audioKind(req);
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
        if (abort.signal.aborted) throw failure(408, 'Recording upload timed out.', 'timeout');
        length += chunk.length;
        if (length > MAX_AUDIO_BYTES) throw failure(413, 'Recording exceeds 10 MiB.', 'too_large');
        chunks.push(chunk);
      }
      if (length !== kind.size)
        throw failure(400, 'Recording upload was incomplete. Try again.', 'unavailable');
      audio = Buffer.concat(chunks);
      if (!validSignature(audio, kind.ext))
        throw failure(422, 'Could not read the audio recording.', 'unreadable');
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
        if (response.status === 429)
          throw failure(429, 'Transcription rate limit reached. Try again later.', 'rate_limited');
        if ([401, 403].includes(response.status))
          throw failure(503, 'The transcription service rejected the credential.', 'auth_failed');
        if ([400, 413, 415, 422].includes(response.status))
          throw failure(
            422,
            'The service could not transcribe this recording. Try recording again.',
            'unreadable',
          );
        throw failure(503, 'Transcription is unavailable. Try sending the recording again.', 'unavailable');
      }
      const result = await boundedJson(response, abort.signal);
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string')
        throw failure(502, 'Invalid transcription response.', 'unavailable');
      const transcript = result.text.trim();
      if (!transcript) throw failure(422, 'No speech was recognized. Try recording again.', 'no_speech');
      if (transcript.length > MAX_TRANSCRIPT_CHARS)
        throw failure(422, 'Transcript is too long. Split the recording.', 'too_long');
      return json(res, 200, { text: transcript });
    } catch (error) {
      const timedOut = abort.signal.aborted;
      return json(res, timedOut ? 504 : error.status || 503, {
        error: timedOut
          ? 'Transcription timed out. Try sending the recording again.'
          : error.status
            ? error.message
            : 'Transcription is unavailable. Try sending the recording again.',
        code: timedOut ? 'timeout' : error.code || 'unavailable',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', disconnect);
      res.off('close', close);
      if (audio) audio.fill(0);
      busy = false;
    }
  }

  // Full-control settings view: the Whisper URL is visible here, never in the
  // read-only status, and the Groq key itself is never returned.
  async function settings() {
    const config = await configuration();
    return { ...config.settings, status: config.publicStatus, keySource: config.keySource };
  }

  async function updateSettings(patch) {
    validateVoicePatch(patch);
    if (!file) throw failure(503, 'Voice settings are unavailable.', 'unavailable');
    const operation = writes
      .catch(() => {})
      .then(async () => {
        const next = normalizeSettings({ ...(await readSettings(file)), ...patch });
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temp, file);
      });
    writes = operation;
    await operation;
    return settings();
  }

  return {
    status: async () => ({ ...(await configuration()).publicStatus }),
    settings,
    updateSettings,
    transcribe,
  };
}
