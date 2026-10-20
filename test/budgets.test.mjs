import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetSettings, normalizeBudgetLimits } from '../lib/budgets.mjs';
import { createBudgetGuard } from '../runtime/studio-budget-extension.mjs';

test('budget settings off by default, strict validation and optimistic revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-test-'));
  try {
    const settings = createBudgetSettings({ dataDir: root });
    const initial = await settings.read();
    assert.equal(initial.run.tokens, null);
    assert.throws(() => normalizeBudgetLimits({ tokens: -1 }));
    assert.throws(() => normalizeBudgetLimits({ estimatedCost: Infinity }));
    const updated = await settings.write({ ...initial, run: { tokens: 100, estimatedCost: 1 }, projects: { [root]: { tokens: 200, estimatedCost: 2 } } });
    assert.equal(updated.revision, 1);
    await assert.rejects(settings.write(initial), /revision/i);
    const resolved = await settings.forRun(root);
    assert.equal(resolved.project.tokens, 200);
    assert.equal(resolved.tokens, 100);
    assert.ok(resolved.ledgerDir);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('80% warning, no-question stop at safe point and explicit resume choices', async () => {
  const events = [];
  let aborted = 0;
  const guard = createBudgetGuard({ tokens: 100 }, (budget) => events.push(budget));
  guard.record({ input: 80, output: 0 });
  assert.equal(events.at(-1).status, 'warning');
  guard.record({ input: 20 });
  await guard.check({ abort() { aborted++; } });
  assert.equal(aborted, 1);
  assert.equal(events.at(-1).status, 'stopped');
  const resume = createBudgetGuard({ tokens: 100, allowQuestions: true }, (budget) => events.push(budget));
  resume.record({ input: 100 });
  await resume.check({ abort() { aborted++; }, ui: { select: async () => 'Continue +50%' } });
  assert.equal(events.at(-1).limits.tokens, 150);
  assert.equal(aborted, 1);
  resume.record({ output: 50 });
  await resume.check({ abort() { aborted++; }, ui: { select: async () => 'Unlimited this run' } });
  assert.equal(events.at(-1).status, 'unlimited');
});

test('daily project and run totals aggregate sibling instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-ledger-'));
  try {
    const config = { tokens: 1000, project: { tokens: 100 }, projectKey: 'project', ledgerDir: root, runId: 'run1' };
    const one = createBudgetGuard(config, () => {});
    const two = createBudgetGuard({ ...config, runId: 'run2' }, () => {});
    one.record({ input: 60 }); two.record({ input: 40 });
    let aborted = false;
    await one.check({ abort() { aborted = true; } });
    assert.equal(aborted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown cost with cost cap and cancelled question fail closed', async () => {
  for (const config of [{ estimatedCost: 1 }, { tokens: 1, allowQuestions: true }]) {
    let aborted = false;
    const guard = createBudgetGuard(config, () => {});
    guard.record({ input: 1 });
    await guard.check({ abort() { aborted = true; }, ui: { select: async () => undefined } });
    assert.equal(aborted, true);
    assert.equal(guard.state().status, 'stopped');
  }
});

test('a run extension is shared with children but not other project runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-decisions-'));
  try {
    const config = { tokens: 100, project: { tokens: 100 }, projectKey: 'project', ledgerDir: root, runId: 'one', allowQuestions: true };
    const one = createBudgetGuard(config, () => {});
    const child = createBudgetGuard({ ...config, allowQuestions: false }, () => {});
    one.record({ input: 100, cost: 0 });
    await one.check({ abort() { assert.fail('must continue'); }, ui: { select: async () => 'Unlimited this run' } });
    await child.check({ abort() { assert.fail('child must share decision'); } });
    const other = createBudgetGuard({ ...config, runId: 'two', allowQuestions: false }, () => {});
    let stopped = false;
    await other.check({ abort() { stopped = true; } });
    assert.equal(stopped, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt persisted settings are refused, never silently disable limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-corrupt-'));
  try {
    await writeFile(join(root, 'budget-settings.json'), JSON.stringify({ revision: 1, period: 'day', run: { tokens: -1 }, projects: {} }));
    await assert.rejects(createBudgetSettings({ dataDir: root }).read());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native zero estimated cost is unknown when model pricing is unavailable', async () => {
  let stopped = false;
  const guard = createBudgetGuard({ estimatedCost: 1 }, () => {});
  guard.record({ input: 10, cost: { total: 0 } }, false);
  await guard.check({ abort() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(guard.state().reason, 'cost_unknown');
});

test('aborted assistant usage cannot overwrite the stopped status snapshot', async () => {
  const events = [];
  const guard = createBudgetGuard({ tokens: 1 }, (event) => events.push(event));
  guard.record({ input: 1 });
  await guard.check({ abort() {} });
  guard.record({ input: 0, output: 0 });
  assert.equal(events.at(-1).status, 'stopped');
});

test('valid JSON corrupted decision and ledger rows fail closed', async () => {
  for (const corrupt of [{}, [], null, { revision: 0, multiplier: -1, unlimited: false, stopped: false }, { revision: 0, multiplier: null, unlimited: false, stopped: false }, { revision: 0, multiplier: 1, unlimited: false, stopped: 'no' }, { multiplier: 1, unlimited: 'yes', stopped: false }]) {
    const root = await mkdtemp(join(tmpdir(), 'budget-corruption-'));
    try {
      const guard = createBudgetGuard({ tokens: 10, ledgerDir: root, projectKey: 'p', runId: 'r' }, () => {});
      guard.record({ input: 20 });
      await writeFile(join(root, 'r.decision.json'), JSON.stringify(corrupt));
      let stopped = false;
      await guard.check({ abort() { stopped = true; } });
      assert.equal(stopped, true);
      assert.equal(guard.state().reason, 'ledger_unavailable');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  for (const counters of [{ tokens: -1, estimatedCost: 0, costKnown: true }, { tokens: 0, estimatedCost: null, costKnown: true }, { tokens: 1, estimatedCost: 0, costKnown: 'yes' }]) {
    const root = await mkdtemp(join(tmpdir(), 'budget-row-'));
    try {
      const guard = createBudgetGuard({ tokens: 10, ledgerDir: root, projectKey: 'p', runId: 'r' }, () => {});
      await writeFile(join(root, 'p--bad.usage.json'), JSON.stringify({ ...counters, runId: 'r', day: '2026-10-20' }));
      let stopped = false; await guard.check({ abort() { stopped = true; } });
      assert.equal(stopped, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('child-first cap stops child locally and root still owns the question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-child-'));
  try {
    const config = { tokens: 10, ledgerDir: root, projectKey: 'p', runId: 'r', allowQuestions: true };
    const parent = createBudgetGuard(config, () => {});
    const child = createBudgetGuard(config, () => {});
    child.record({ input: 10 });
    let stopped = false, asked = false;
    await child.check({ sessionManager: { getHeader: () => ({ parentSession: 'parent' }) }, abort() { stopped = true; } });
    assert.equal(stopped, true);
    await parent.check({ abort() { assert.fail('root should ask'); }, ui: { select: async () => { asked = true; return 'Continue +50%'; } } });
    assert.equal(asked, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('terminal concurrent stop wins over stale root question answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-race-'));
  try {
    const config = { tokens: 10, ledgerDir: root, projectKey: 'p', runId: 'r', allowQuestions: true };
    const parent = createBudgetGuard(config, () => {});
    const worker = createBudgetGuard({ ...config, allowQuestions: false }, () => {});
    parent.record({ input: 10 });
    let answer, stopped = false;
    const waiting = parent.check({ abort() { stopped = true; }, ui: { select: () => new Promise((resolve) => { answer = resolve; }) } });
    await worker.check({ abort() {} });
    answer('Continue +50%'); await waiting;
    assert.equal(stopped, true);
    assert.equal(parent.state().status, 'stopped');
  } finally { await rm(root, { recursive: true, force: true }); }
});
