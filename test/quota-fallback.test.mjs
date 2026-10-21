import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyQuotaFailure, planQuotaFallback, createQuotaFallbackStore } from '../lib/quota-fallback.mjs';

test('quota classification parses only quota errors and safe reset fields', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const failure = classifyQuotaFailure({ status: 429, headers: { 'retry-after': '120', authorization: 'secret' } }, { provider: 'meta', now });
  assert.equal(failure.kind, 'rate_limit');
  assert.equal(failure.resetAt, '2026-01-01T00:02:00.000Z');
  assert.equal(JSON.stringify(failure).includes('secret'), false);
  assert.equal(classifyQuotaFailure('usage_limit_reached', { provider: 'openai-codex', now }).kind, 'usage_limit');
  assert.equal(classifyQuotaFailure('401 unauthorized'), null);
  assert.equal(classifyQuotaFailure('500 network timeout'), null);
});

test('ordered fallback requires proven same identity and billing, never Muse to Meta', () => {
  const failure = classifyQuotaFailure('429 Too Many Requests', { provider: 'muse-code' });
  const identity = { provider: 'muse-code', accountId: 'a', credentialId: 'c', billing: 'subscription' };
  const settings = { automatic: true, models: ['meta/paid', 'muse-code/unknown', 'muse-code/next'] };
  const plan = planQuotaFallback({ failure, currentModel: 'muse-code/current', settings, availableModels: settings.models.map(id => ({ id })), identities: {
    'muse-code/current': identity, 'muse-code/next': identity,
    'meta/paid': { ...identity, provider: 'meta', billing: 'pay_per_use' },
  } });
  assert.deepEqual(plan.candidates.map(x => x.model), settings.models);
  assert.equal(plan.automaticModel, 'muse-code/next');
  assert.equal(plan.candidates[0].automaticEligible, false);
  assert.equal(plan.candidates[1].reason, 'identity_unknown');
  assert.equal(JSON.stringify(plan).includes('credentialId'), false);
  assert.equal(planQuotaFallback({ failure, currentModel: 'muse-code/current', settings }).automaticModel, null);
  assert.equal(planQuotaFallback({ failure, currentModel: 'muse-code/current', settings: { ...settings, automatic: false }, identities: { 'muse-code/current': identity, 'muse-code/next': identity } }).automaticModel, null);
});

test('fallback settings persist independently and reject untrusted identity fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createQuotaFallbackStore({ file: join(dir, 'quota.json') });
  const initial = await store.get();
  assert.equal(initial.automatic, false);
  assert.deepEqual(initial.models, []);
  const saved = await store.set({ revision: initial.revision, automatic: true, models: ['meta/a', 'meta/b'] });
  assert.deepEqual(await store.get(), saved);
  await assert.rejects(store.set({ revision: initial.revision, automatic: false, models: [] }), { status: 409 });
  await assert.rejects(store.set({ automatic: true, models: ['meta/a'], identities: {} }));
  await assert.rejects(store.set({ automatic: 'yes', models: [] }));
});

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../lib/agent.mjs';

test('runtime localhost 429 projects reset and candidates and never starts another process', async t => {
  const server = createServer((req, res) => { res.writeHead(429, { 'retry-after': '30' }); res.end('quota'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), 'studio-quota-runtime-'));
  const settings = { automatic: true, models: ['meta/next'] };
  const runtime = createAgentRuntime({ agentHome: dir, sessionDir: join(dir, 'sessions'),
    cliPath: fileURLToPath(new URL('./fixtures/quota-cli.mjs', import.meta.url)),
    env: { STUDIO_TEST_QUOTA_URL: `http://127.0.0.1:${server.address().port}` },
    quotaFallback: { get: async () => settings },
    nativeModelCatalog: { read: async () => ({ models: [{ id: 'next', provider: 'meta' }] }), close: async () => {} },
  });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const events = [];
  const handle = await runtime.start({ cwd: dir, model: 'meta/current', message: 'fail', onEvent: event => events.push(event) });
  const done = await handle.done;
  assert.equal(done.status, 'failed');
  assert.equal(done.quota.kind, 'rate_limit');
  assert.equal(done.quota.retryAfterSeconds, 30);
  assert.equal(done.quota.automaticModel, null);
  assert.equal(done.quota.candidates[0].model, 'meta/next');
  assert.equal(events.filter(event => event.kind === 'done').length, 1);
  const recovered = await runtime.start({ cwd: dir, model: 'meta/current', message: 'recover' });
  assert.equal((await recovered.done).quota, undefined);
  const unauthorized = await runtime.start({ cwd: dir, model: 'meta/current', message: 'unauthorized' });
  assert.equal((await unauthorized.done).quota, undefined);
});

import { writeFile } from 'node:fs/promises';
import { resolveQuotaIdentities } from '../lib/quota-fallback.mjs';

test('native subscription identity proof rejects custom overrides and unknown credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-quota-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = ['openai-codex/a', 'openai-codex/b', 'meta/c'];
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'secret-access', refresh: 'secret-refresh' }, meta: { type: 'api_key', key: 'secret-key' } }));
  const identities = await resolveQuotaIdentities({ agentHome: dir, models });
  assert.deepEqual(identities[models[0]], identities[models[1]]);
  assert.equal(identities['meta/c'], undefined);
  assert.equal(JSON.stringify(identities).includes('secret'), false);
  await writeFile(join(dir, 'models.json'), '{// custom override\n"providers":{"openai-codex":{}}}');
  assert.deepEqual(await resolveQuotaIdentities({ agentHome: dir, models }), {});
  await writeFile(join(dir, 'models.json'), 'broken');
  assert.deepEqual(await resolveQuotaIdentities({ agentHome: dir, models }), {});
});

test('quota reset supports durations, HTTP dates and Codex reset epoch without leaking body', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const cases = [
    [{ status: 429, headers: { 'x-ratelimit-reset-tokens': '1m30s' } }, 90],
    [{ status: 429, headers: { 'retry-after': 'Thu, 01 Jan 2026 00:02:00 GMT' } }, 120],
    [{ error: { type: 'usage_limit_reached', resets_at: now / 1000 + 60 } }, 60],
  ];
  for (const [error, seconds] of cases) assert.equal(classifyQuotaFailure(error, { now }).retryAfterSeconds, seconds);
  assert.equal(classifyQuotaFailure({ status: 429, headers: { 'retry-after': 'secret' } }, { now }).resetAt, null);
});

import { verifyQuotaAuthorization } from '../lib/quota-fallback.mjs';
test('automatic admission rejects changed credential and wrong target after scheduling', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-quota-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = { 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r' } };
  await writeFile(join(dir, 'auth.json'), JSON.stringify(auth));
  const models = ['openai-codex/a', 'openai-codex/b'];
  const authorization = { sourceModel: models[0], targetModel: models[1], identities: await resolveQuotaIdentities({ agentHome: dir, models }) };
  await verifyQuotaAuthorization({ agentHome: dir, authorization, currentModel: models[1] });
  await assert.rejects(verifyQuotaAuthorization({ agentHome: dir, authorization, currentModel: models[0] }));
  auth['openai-codex'].access = 'changed';
  await writeFile(join(dir, 'auth.json'), JSON.stringify(auth));
  await assert.rejects(verifyQuotaAuthorization({ agentHome: dir, authorization, currentModel: models[1] }));
});

test('native provider diagnostics carry quota status and reset even when error text is generic', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const failure = classifyQuotaFailure({ errorMessage: 'Provider refused request', diagnostics: [{ type: 'provider_stream_failure', details: { kind: 'rate_limit', status: 429, retryAfterMs: 2500, providerErrorType: 'usage_limit_reached' }, error: { stack: 'private' } }] }, { now });
  assert.equal(failure.kind, 'usage_limit');
  assert.equal(failure.resetAt, '2026-01-01T00:00:02.500Z');
  assert.equal(JSON.stringify(failure).includes('private'), false);
});

test('legacy in-loop native backup is refused for every provider without changing settings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-quota-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'a', providerBackupModel: 'openai/paid' });
  await writeFile(join(dir, 'settings.json'), original);
  const runtime = createAgentRuntime({ agentHome: dir, sessionDir: join(dir, 'sessions'), cliPath: fileURLToPath(new URL('./fixtures/quota-cli.mjs', import.meta.url)) });
  t.after(() => runtime.close());
  await assert.rejects(runtime.start({ cwd: dir, message: 'must not spawn' }), /providerBackupModel is not supported/);
  assert.equal(await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'settings.json'), 'utf8')), original);
});

test('unknown catalogue availability never authorizes automatic fallback', () => {
  const identity = { provider: 'muse-code', accountId: 'a', credentialId: 'c', billing: 'subscription' };
  const plan = planQuotaFallback({ failure: {}, currentModel: 'muse-code/a', settings: { automatic: true, models: ['muse-code/b'] }, identities: { 'muse-code/a': identity, 'muse-code/b': identity }, availableModels: [{ id: 'muse-code/b', availability: 'unknown' }] });
  assert.equal(plan.automaticModel, null);
});

test('absent catalogue never authorizes automatic fallback', () => {
  const identity = { provider: 'muse-code', accountId: 'a', credentialId: 'c', billing: 'subscription' };
  const plan = planQuotaFallback({ failure: {}, currentModel: 'muse-code/a', settings: { automatic: true, models: ['muse-code/b'] }, identities: { 'muse-code/a': identity, 'muse-code/b': identity } });
  assert.equal(plan.automaticModel, null);
});
