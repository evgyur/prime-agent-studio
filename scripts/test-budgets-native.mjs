// Real engine, isolated local provider only. No user account or remote request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bounded } from './fixtures/timeout.mjs';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';
import { createBudgetSettings } from '../lib/budgets.mjs';
const root = await mkdtemp(join(tmpdir(), 'studio-budgets-native-'));
const cwd = join(root, 'project'), agentHome = join(root, 'agent'), sessionDir = join(root, 'sessions');
await Promise.all([cwd, agentHome, sessionDir].map((p) => mkdir(p, { recursive: true })));
const requests = [];
let childBudget;
const provider = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const childScenario = body.model === 'budget-child' || JSON.stringify(body.messages).includes('ROOT_CHILD_BUDGET_FIXTURE');
    const child = body.model === 'budget-child';
    const toolResults = body.messages.filter((m) => m.role === 'tool').length;
    if (childScenario && !child && toolResults === 1) {
      await bounded((async () => {
        for (;;) {
          const names = await readdir(childBudget.ledgerDir);
          const rows = await Promise.all(names.filter((name) => name.includes(`--${childBudget.runId}--`) && name.endsWith('.usage.json')).map(async (name) => JSON.parse(await readFile(join(childBudget.ledgerDir, name), 'utf8'))));
          if (rows.some((row) => row.tokens >= 100)) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(), 'native child shared usage', 20000);
    }
    const result = body.messages.some((m) => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
      id: 'budget-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    frame({ role: 'assistant' });
    if (childScenario) {
      const code = child ? "raise AssertionError('child tool must be blocked')" : toolResults === 0
        ? 'import rlm\nawait rlm.spawn("CHILD_BUDGET_FIXTURE", model="fixture/budget-child", thinking="off", name="budget-child")\nprint("child admitted")'
        : toolResults === 1 ? 'print("root continued")' : null;
      if (code) {
        frame({ tool_calls: [{ index: 0, id: `budget-child-${requests.length}`, type: 'function', function: { name: 'ipython', arguments: JSON.stringify({ code }) } }] });
        const tokens = child ? 100 : toolResults === 0 ? 10 : 0;
        frame({}, 'tool_calls', { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens });
      } else {
        frame({ content: 'Root and child budget fixture complete.' });
        frame({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      }
    } else if (!result) {
      frame({ tool_calls: [{ index: 0, id: 'budget-tool', type: 'function', function: { name: 'ipython', arguments: JSON.stringify({ code: "print('budget fixture')" }) } }] });
      frame({}, 'tool_calls', { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 });
    } else {
      frame({ content: 'Budget fixture complete.' });
      frame({}, 'stop', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    }
    res.end('data: [DONE]\n\n');
  } catch (error) { res.destroy(error); }
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(join(agentHome, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture',
  models: ['budget', 'budget-child'].map((id) => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 4096 })),
} } }));
await writeFile(join(agentHome, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'budget', defaultThinkingLevel: 'off',
  autoRefine: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false }, telemetry: { enabled: false, noticeShown: true } }));
const budgets = createBudgetSettings({ dataDir: join(root, 'data') });
await budgets.write({ ...(await budgets.read()), run: { tokens: 100 } });
const runtime = createAgentRuntime({ agentHome, sessionDir, kernelRoot: root, env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' } });
const report = { engine: discoverCli().packageDir, cases: [] };
let failure;
try {
  for (const answer of [null, 'policy-stop', 'Continue +50%', 'Unlimited this run', 'Stop']) {
    const events = [], start = requests.length;
    let resolveQuestion;
    const question = new Promise((resolve) => { resolveQuestion = resolve; });
    const handle = await bounded(runtime.start({ cwd, message: 'Run budget fixture.', model: 'fixture/budget', thinking: 'off',
      allowQuestions: answer !== null, budget: { ...(await budgets.forRun(cwd)), allowQuestions: answer !== 'policy-stop' },
      onEvent(event) { events.push(event); if (event.kind === 'interaction' && event.request.status === 'pending') resolveQuestion(event.request); },
    }), 'start', 60000);
    if (answer !== null && answer !== 'policy-stop') {
      const request = await bounded(question, 'budget native question', 30000);
      assert.deepEqual(request.options, ['Continue +50%', 'Unlimited this run', 'Stop']);
      await handle.respond(request.id, { value: answer });
    }
    const done = await bounded(handle.done, 'budget completion', 30000);
    const stopped = answer === null || answer === 'policy-stop' || answer === 'Stop';
    assert.equal(requests.length - start, stopped ? 1 : 2, JSON.stringify({ answer, events, done }));
    assert.equal(done.status, stopped ? 'stopped' : 'completed', JSON.stringify({ answer, events, done }));
    assert.ok(events.some((event) => event.kind === 'budget'), 'structured budget status');
    report.cases.push({ answer, requests: requests.length - start, status: done.status });
  }
  // Child spends past the shared cap first. It must stop locally; the root owns the question.
  childBudget = await budgets.forRun(cwd);
  {
    const events = [], start = requests.length;
    let resolveQuestion;
    const question = new Promise((resolve) => { resolveQuestion = resolve; });
    const handle = await bounded(runtime.start({ cwd, message: 'ROOT_CHILD_BUDGET_FIXTURE', model: 'fixture/budget', thinking: 'off',
      allowQuestions: true, budget: childBudget,
      onEvent(event) { events.push(event); if (event.kind === 'interaction' && event.request.status === 'pending') resolveQuestion(event.request); },
    }), 'child scenario start', 60000);
    const request = await bounded(question, 'root question after child cap', 45000);
    await handle.respond(request.id, { value: 'Unlimited this run' });
    const done = await bounded(handle.done, 'child scenario completion', 45000);
    assert.equal(done.status, 'completed', JSON.stringify({ done, events }));
    const calls = requests.slice(start);
    assert.equal(calls.filter((r) => r.model === 'budget-child').length, 1, 'child stops before second provider call');
    const rootCalls = calls.filter((r) => r.model === 'budget').length;
    // Native child completion may be coalesced into the resumed turn or delivered as one follow-up.
    assert.ok(rootCalls === 3 || rootCalls === 4, `unexpected root provider calls: ${rootCalls}`);
    const rows = await Promise.all((await readdir(childBudget.ledgerDir)).filter((name) => name.includes(`--${childBudget.runId}--`) && name.endsWith('.usage.json')).map(async (name) => JSON.parse(await readFile(join(childBudget.ledgerDir, name), 'utf8'))));
    assert.equal(rows.length, 2, 'native root and child share run ledger');
    const sharedTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    assert.equal(sharedTokens, 110 + (rootCalls - 2) * 2);
    report.cases.push({ scenario: 'native child-first shared cap root question', requests: calls.length, status: done.status, sharedTokens });
  }
  // Prior runs used more than 100 tokens today. Admission must abort before HTTP.
  await budgets.write({ ...(await budgets.read()), run: { tokens: null }, projects: { [cwd]: { tokens: 100 } } });
  const start = requests.length;
  const events = [];
  const handle = await bounded(runtime.start({ cwd, message: 'Must not call provider.', model: 'fixture/budget', thinking: 'off',
    allowQuestions: false, budget: await budgets.forRun(cwd), onEvent(event) { events.push(event); },
  }), 'exhausted project start', 60000);
  const done = await bounded(handle.done, 'exhausted project completion', 30000);
  assert.equal(requests.length, start, 'exhausted project must prevent initial HTTP request');
  assert.equal(done.status, 'stopped', JSON.stringify({ done, events }));
  report.cases.push({ scenario: 'exhausted daily project before initial provider request', requests: 0, status: done.status });
} catch (error) { failure = error; report.error = String(error.stack || error); }
finally {
  try { await bounded(runtime.close(), 'close runtime', 30000); } catch (error) { failure ||= error; }
  provider.closeAllConnections(); await new Promise((done) => provider.close(done));
  await mkdir('test-results/budgets', { recursive: true });
  report.passed = !failure;
  await writeFile(resolve('test-results/budgets/native-proof.json'), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
