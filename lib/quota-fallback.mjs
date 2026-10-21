import { readFile, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { stripJsonComments } from './jsonc.mjs';
import { HttpError } from './store.mjs';
import { rateLimitHeaders } from '../runtime/studio-metrics-extension.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\/[^\s\x00-\x1f]{1,399}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function settingsOf(value) {
  if (!record(value) || Object.keys(value).some(key => !['revision', 'automatic', 'models'].includes(key)) ||
      typeof value.automatic !== 'boolean' || !Array.isArray(value.models) || value.models.length > 20 ||
      value.models.some(model => !modelId(model)) || new Set(value.models).size !== value.models.length)
    throw new HttpError(400, 'Invalid quota fallback settings.');
  return { automatic: value.automatic, models: [...value.models] };
}

export function createQuotaFallbackStore({ dataDir, file = join(dataDir, 'quota-fallback.json') }) {
  let writes = Promise.resolve();
  async function get() {
    let settings;
    try { settings = settingsOf(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new HttpError(409, 'Quota fallback settings cannot be read.');
      settings = { automatic: false, models: [] };
    }
    return { ...settings, revision: digest(settings) };
  }
  function set(value) {
    const operation = writes.then(async () => {
      const settings = settingsOf(value);
      const current = await get();
      if (value.revision !== current.revision) throw new HttpError(409, 'Quota fallback settings changed. Reload them.');
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(settings) + '\n', { mode: 0o600 });
      await rename(temporary, file);
      return { ...settings, revision: digest(settings) };
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return { get, set };
}

function resetTime(value, now, duration = false) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    return duration ? now + number * 1000 : number > 1e12 ? number : number > 1e9 ? number * 1000 : now + number * 1000;
  }
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text)) {
    let ms = 0;
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g))
      ms += Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]);
    return now + ms;
  }
  return Date.parse(text);
}

export function classifyQuotaFailure(error, { provider = '', now = Date.now() } = {}) {
  const message = typeof error === 'string' ? error : String(error?.errorMessage || error?.message || error?.error?.message || '');
  const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics : [];
  const native = diagnostics.findLast(item => item?.type === 'provider_stream_failure')?.details;
  const code = String(error?.code || error?.error?.code || error?.error?.type || native?.providerErrorType || '');
  const status = Number(error?.status || error?.statusCode || error?.response?.status || native?.status) || null;
  const usage = /\b(?:usage_limit_reached|usage limit|quota_exceeded|insufficient_quota|quota exceeded)\b/i.test(`${code} ${message}`);
  if (!usage && status !== 429 && !/\b429\b|\brate_limit_exceeded\b|\btoo many requests\b/i.test(`${code} ${message}`)) return null;
  const headers = rateLimitHeaders(error?.headers || error?.response?.headers);
  const resets = Object.entries(headers).filter(([key]) => key === 'retry-after' || key.includes('reset'))
    .map(([key, value]) => resetTime(value, now, key === 'retry-after'));
  if (typeof native?.retryAfterMs === 'number' && Number.isFinite(native.retryAfterMs) && native.retryAfterMs >= 0)
    resets.push(now + native.retryAfterMs);
  const bodyReset = error?.resets_at ?? error?.reset_at ?? error?.error?.resets_at;
  if (bodyReset != null) resets.push(resetTime(bodyReset, now));
  const valid = resets.filter(value => Number.isFinite(value) && value >= now && value <= now + 366 * 86400000);
  const reset = valid.length ? Math.max(...valid) : null;
  return {
    kind: usage ? 'usage_limit' : 'rate_limit', provider,
    status: status === 429 || /\b429\b/.test(message) ? 429 : null,
    resetAt: reset === null ? null : new Date(reset).toISOString(),
    retryAfterSeconds: reset === null ? null : Math.ceil((reset - now) / 1000), headers,
  };
}

export function planQuotaFallback({ failure, currentModel, settings, identities = {}, availableModels }) {
  if (!failure) return null;
  const available = new Set((availableModels || []).filter(model => !['unavailable', 'unknown'].includes(model.availability)).map(model => model.id));
  const source = identities[currentModel];
  const candidates = (settings?.models || []).filter(model => model !== currentModel).map(model => {
    const target = identities[model];
    let reason = 'eligible';
    if (!available.has(model)) reason = 'unavailable';
    else if (!source?.accountId || !source?.credentialId || !target?.accountId || !target?.credentialId ||
             !source?.billing || !target?.billing) reason = 'identity_unknown';
    else if (source.provider !== target.provider || currentModel.split('/')[0] !== model.split('/')[0]) reason = 'provider_changed';
    else if (source.billing !== target.billing) reason = 'billing_changed';
    else if (source.accountId !== target.accountId || source.credentialId !== target.credentialId) reason = 'identity_changed';
    else if (!settings.automatic) reason = 'automatic_disabled';
    return { model, automaticEligible: reason === 'eligible', reason };
  });
  return { ...failure, candidates, automaticModel: candidates.find(candidate => candidate.automaticEligible)?.model || null };
}

// A stored native OAuth credential proves shared account/billing only for these
// subscription providers. API keys, env credentials and user overrides are unknown.
export async function resolveQuotaIdentities({ agentHome, models }) {
  async function localJson(name, jsonc = false) {
    const file = join(agentHome, name);
    const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) return {};
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Unsafe config');
    const text = await readFile(file, 'utf8');
    const value = JSON.parse(jsonc ? stripJsonComments(text) : text);
    if (!record(value)) throw new Error('Invalid config');
    return value;
  }
  try {
    const [auth, config] = await Promise.all([localJson('auth.json'), localJson('models.json', true)]);
    const identities = {};
    for (const model of models) {
      if (!modelId(model)) continue;
      const provider = model.split('/')[0];
      if (!['openai-codex', 'muse-code'].includes(provider) || Object.hasOwn(config.providers || {}, provider)) continue;
      const credential = auth[provider];
      if (credential?.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access ||
          typeof credential.refresh !== 'string' || !credential.refresh) continue;
      // Same persisted credential is a stronger equality proof than an unverified
      // account claim decoded from a token. Neither credential nor hash leaves server.
      const credentialId = digest(credential);
      identities[model] = { provider, accountId: credentialId, credentialId, billing: 'subscription' };
    }
    return identities;
  } catch { return {}; }
}

export async function verifyQuotaAuthorization({ agentHome, authorization, currentModel }) {
  const { sourceModel, targetModel, identities } = authorization || {};
  if (!modelId(sourceModel) || !modelId(targetModel) || targetModel !== currentModel || !record(identities))
    throw new HttpError(409, 'Automatic quota retry authorization is invalid.');
  const latest = await resolveQuotaIdentities({ agentHome, models: [sourceModel, targetModel] });
  for (const model of [sourceModel, targetModel]) {
    const expected = identities[model], actual = latest[model];
    if (!expected || !actual || ['provider', 'accountId', 'credentialId', 'billing'].some(key => expected[key] !== actual[key]))
      throw new HttpError(409, 'Provider identity changed. Automatic quota retry was refused.');
  }
  const plan = planQuotaFallback({ failure: {}, currentModel: sourceModel,
    // Catalogue eligibility is rechecked by server admission; this final gate
    // checks only that the authorized source/target account has not changed.
    settings: { automatic: true, models: [targetModel] }, identities: latest,
    availableModels: [{ id: targetModel }] });
  if (plan.automaticModel !== targetModel) throw new HttpError(409, 'Automatic quota retry is not permitted.');
}

// Native transport emits only allowlisted quota/reset metadata, never response bodies.
export default function studioQuotaFallback(pi) {
  const quotaFile = process.env.PRIME_STUDIO_QUOTA_FILE;
  pi.on('after_provider_response', (event, ctx) => {
    const quota = classifyQuotaFailure({ status: event.status, headers: event.headers }, { provider: ctx.model?.provider || '' });
    // The owned daemon does not forward arbitrary extension stdout. Keep a
    // run-local allowlisted snapshot for the terminal event instead.
    if (quotaFile) {
      try { writeFileSync(quotaFile, JSON.stringify({ quota }), { mode: 0o600 }); }
      catch { /* Quota reporting must not affect provider handling. */ }
    }
  });
}
