// Deterministic real-engine quota proof. Only a localhost fixture is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bounded } from './fixtures/timeout.mjs';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'studio-native-quota-'));
const agentHome = join(root, 'agent'), sessionDir = join(root, 'sessions'), cwd = join(root, 'project');
await Promise.all([agentHome, sessionDir, cwd].map(path => mkdir(path, { recursive: true })));
let requests = 0;
const requestedModels = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests++;
  requestedModels.push(body.model);
  if (body.model === 'next') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
      id: 'quota-retry-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    frame({ role: 'assistant' });
    frame({ content: 'Confirmed fallback completed in the same conversation.' });
    frame({}, 'stop', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', 'x-ratelimit-reset-tokens': '2s' });
  res.end(JSON.stringify({ error: { message: 'Fixture quota exhausted', type: 'rate_limit_exceeded' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const settings = { defaultProvider: 'fixture', defaultModel: 'quota', defaultThinkingLevel: 'off',
  autoRefine: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false },
  telemetry: { enabled: false, noticeShown: true } };
await writeFile(join(agentHome, 'settings.json'), JSON.stringify(settings));
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(join(agentHome, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only',
  models: ['quota', 'next'].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 512 }))
} } }));
const cli = discoverCli();
const runtime = createAgentRuntime({ agentHome, sessionDir, kernelRoot: root,
  env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' }, quotaFallback: { get: async () => ({ automatic: true, models: ['fixture/next'] }) } });
const app = createApp({ agentHome, sessionDir, dataDir: join(root, 'local'), initialCwd: cwd, runtime });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
    method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
};
const report = { engine: cli?.packageDir };
let failure;
try {
  const initial = await api('/api/quota-fallback');
  const configured = await api('/api/quota-fallback', 'PUT', { ...initial.data, automatic: true, models: ['fixture/next'] });
  assert.equal(configured.status, 200, JSON.stringify(configured));
  const started = await bounded(api('/api/runs', 'POST', { cwd, model: 'fixture/quota', message: 'Local quota proof', thinking: 'off', allowQuestions: false }), 'start', 60000);
  assert.equal(started.status, 201, JSON.stringify(started));
  const handle = app.runs.get(started.data.id).handle;
  const done = await bounded(handle.done, 'quota completion', 60000);
  report.done = done;
  report.requests = requests;
  assert.equal(done.status, 'failed');
  assert.equal(done.quota.kind, 'rate_limit');
  assert.equal(done.quota.status, 429);
  assert.ok(done.quota.resetAt);
  assert.equal(done.quota.automaticModel, null);
  assert.equal(done.quota.candidates[0].reason, 'identity_unknown');
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), JSON.stringify(settings));
  assert.equal(app.runs.size, 1, 'unknown fixture credential never retries automatically');
  const unconfirmed = await api(`/api/runs/${started.data.id}/quota-retry`, 'POST', { model: 'fixture/next' });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.data.code, 'quota_confirmation_required');
  assert.equal(requests, 1);
  const retried = await bounded(api(`/api/runs/${started.data.id}/quota-retry`, 'POST', {
    model: 'fixture/next', confirmBillingChange: true,
  }), 'confirmed retry admission', 60000);
  assert.equal(retried.status, 201, JSON.stringify(retried));
  assert.notEqual(retried.data.id, started.data.id);
  assert.equal(retried.data.sessionId, done.sessionId);
  const retryDone = await bounded(app.runs.get(retried.data.id).handle.done, 'retry completion', 60000);
  assert.equal(retryDone.status, 'completed');
  assert.equal(retryDone.sessionId, done.sessionId);
  assert.deepEqual(requestedModels, ['quota', 'next']);
  report.retry = { status: retryDone.status, newRun: true, sameSession: true, confirmed: true, totalRequests: requests };
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), JSON.stringify(settings));
} catch (error) { failure = error; report.error = String(error.stack || error); }
finally {
  try { await bounded(app.close(), 'cleanup', 30000); report.runtimeClosed = true; }
  catch (error) { failure ||= error; report.cleanupError = String(error); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (report.runtimeClosed) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.passed = !failure;
  const evidence = resolve('test-results/quota-fallback/native-proof.json');
  await mkdir(join(evidence, '..'), { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (failure) process.exitCode = 1;
