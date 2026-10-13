import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createSessionGoals, validateGoalEdit } from '../lib/session-goals.mjs';
import { publicGoal } from '../lib/goal-state.mjs';
import { normalizeEvent } from '../lib/agent.mjs';

const cwd = resolve('test/goal-project');
const original = {
  goalId: 'goal-1',
  objective: 'Finish the project',
  status: 'active',
  active: true,
  tokensUsed: 200,
  tokenBudget: 1000,
  timeUsedSeconds: 10,
  continuationsUsed: 2,
};
const edit = {
  cwd,
  goalId: original.goalId,
  expectedObjective: original.objective,
  objective: 'Ship the project',
};
function fixture(extra = {}) {
  const calls = [];
  const service = createSessionGoals({
    store: { history: async (id) => ({ id, cwd, file: resolve('test/session.jsonl'), goal: original }) },
    getRuns: () => [],
    getClient: () => null,
    getSavedCapabilities: async () => ({ editable: true, controllable: false }),
    editSavedGoal: async (input) => {
      calls.push(input);
      return { ...original, objective: input.objective };
    },
    ...extra,
  });
  return { service, calls };
}

test('idle goal read is passive; edits are scoped to the canonical session file', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.get('thread-1'), { goal: original, editable: true });
  assert.equal(f.calls.length, 0);
  const saved = await f.service.update('thread-1', edit);
  assert.equal(saved.goal.objective, edit.objective);
  assert.equal(saved.goal.tokensUsed, 200);
  assert.equal(f.calls[0].sessionId, 'thread-1');
  assert.equal(f.calls[0].sessionFile, resolve('test/session.jsonl'));
  await assert.rejects(f.service.update('thread-1', { ...edit, cwd: resolve('different') }), { status: 409 });
  assert.equal(f.calls.length, 1);
});

test('an engine without advertised capabilities shows its saved goal read-only', async () => {
  const f = fixture({ getSavedCapabilities: async () => ({ editable: false, controllable: false }) });
  assert.deepEqual(await f.service.get('thread-1'), { goal: original, editable: false });
  assert.equal(f.calls.length, 0);
});

test('live edits use the existing worker and keep maintenance calls out of active sessions', async () => {
  let closed = 0,
    changed = 0;
  const f = fixture({
    getRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
    getClient: () => ({
      getGoal: async () => ({ goal: { ...original, tokensUsed: 245 }, editable: true }),
      editGoal: async (id, directory, input) => {
        assert.equal(id, 'thread-1');
        assert.equal(directory, cwd);
        changed++;
        return { ...original, objective: input.objective };
      },
      close: () => closed++,
    }),
  });
  assert.equal((await f.service.get('thread-1')).goal.tokensUsed, 245);
  assert.equal((await f.service.update('thread-1', edit)).goal.objective, edit.objective);
  assert.equal(changed, 1);
  assert.equal(closed, 2);
  assert.equal(f.calls.length, 0);
});

test('live edit preserves the connected engine control capability in its response', async () => {
  for (const controllable of [true, false]) {
    const f = fixture({
      getRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
      getSavedCapabilities: () => assert.fail('A live edit must not probe an idle engine'),
      getClient: () => ({
        getGoal: async () => ({ goal: original, editable: true, controllable }),
        editGoal: async () => ({ ...original, objective: edit.objective }),
        close() {},
      }),
    });
    assert.deepEqual(await f.service.update('thread-1', edit), {
      goal: { ...original, objective: edit.objective },
      editable: true,
      ...(controllable && { controllable: true }),
    });
  }
});

test('concurrent edits and run admission cannot race a maintenance edit', async () => {
  let settle, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = fixture({
    editSavedGoal: async () => {
      entered();
      return new Promise((done) => {
        settle = done;
      });
    },
  });
  const first = f.service.update('thread-1', edit);
  await started;
  assert.equal(f.service.busy('thread-1'), true);
  await assert.rejects(f.service.update('thread-1', edit), { status: 409 });
  settle({ ...original, objective: edit.objective });
  await first;
  assert.equal(f.service.busy('thread-1'), false);
  await assert.rejects(fixture({ isAdmitting: () => true }).service.update('thread-1', edit), {
    status: 409,
  });
});

test('conflicts and unconfirmed edits never become a success or a blind retry', async () => {
  let calls = 0;
  const f = fixture({
    editSavedGoal: async () => {
      calls++;
      throw Object.assign(new Error('Changed on another device'), { status: 409 });
    },
  });
  await assert.rejects(f.service.update('thread-1', edit), { status: 409 });
  assert.equal(calls, 1);
  assert.equal(f.service.busy('thread-1'), false);
  await assert.rejects(fixture({ editSavedGoal: async () => original }).service.update('thread-1', edit), {
    status: 503,
  });
});

test('validation accepts Unicode characters and forbids budget/status mutation', () => {
  assert.equal([...validateGoalEdit({ ...edit, objective: '🪐'.repeat(4000) }).objective].length, 4000);
  for (const body of [
    null,
    { ...edit, objective: ' ' },
    { ...edit, objective: 'x'.repeat(4001) },
    { ...edit, objective: 'x\0y' },
    { ...edit, tokenBudget: 10000 },
    { ...edit, status: 'active' },
  ])
    assert.throws(() => validateGoalEdit(body), { status: 400 });
  assert.equal(publicGoal({ ...original, status: 'idle' }), null);
  assert.equal(publicGoal({ ...original, tokensUsed: NaN }), null);
  assert.deepEqual(normalizeEvent({ type: 'goal_update', goal: { ...original, privateKey: 'not-public' } }), [
    { kind: 'goal', goal: original },
  ]);
});
