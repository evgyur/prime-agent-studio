import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionActivity } from '../public/session-activity.js';
const summary = (id, n = 1, read = '') => ({
  id,
  updatedAt: `2026-10-11T10:00:0${n}Z`,
  messageCount: n,
  readState: { answer: `${id}-${n}`, read, revision: n },
});
function fixture() {
  const values = new Map(),
    loads = [];
  const activity = createSessionActivity({
    read: (k, f) => values.get(k) ?? f,
    write: (k, v) => values.set(k, v),
    loadHistory: async (id) => {
      loads.push(id);
      return { ...summary(id, 2), messages: [{ id: `${id}-2`, role: 'assistant', text: 'complete answer' }] };
    },
  });
  return { activity, loads, values };
}
test('shared receipts update unopened conversations without fetching their full histories', async () => {
  const { activity, loads } = fixture();
  const sessions = [summary('a'), summary('b', 1, 'b-1')];
  activity.initialize(sessions);
  assert.deepEqual(await activity.sync(sessions, []), []);
  assert.deepEqual(loads, []);
  assert.equal(activity.isUnread('a'), true);
  assert.equal(activity.isUnread('b'), false);
  await activity.sync([summary('a', 2, 'a-2'), summary('b', 2, 'b-1')], []);
  assert.deepEqual(loads, []);
  assert.equal(activity.isUnread('a'), false);
  assert.equal(activity.isUnread('b'), true);
});
test('idle active history still refreshes after an external append, while background receipts stay cheap', async () => {
  const { activity, loads } = fixture();
  activity.observe({ ...summary('a'), messages: [{ id: 'a-1', role: 'assistant', text: 'first' }] });
  const sessions = [summary('a', 2), summary('b', 2)];
  const result = await activity.sync(sessions, [], { activeSessionId: 'a' });
  assert.deepEqual(loads, ['a']);
  assert.equal(result[0].messages[0].text, 'complete answer');
  await activity.sync(sessions, [], { activeSessionId: 'a' });
  assert.deepEqual(loads, ['a']);
  await activity.sync([summary('a', 3), summary('b', 3)], [{ sessionId: 'a', status: 'running' }], {
    activeSessionId: 'a',
  });
  assert.deepEqual(loads, ['a']);
});
test('sessions without shared receipts retain the legacy changed-history fallback', async () => {
  const { activity, loads } = fixture();
  activity.initialize([{ id: 'legacy', updatedAt: 'old', messageCount: 1 }]);
  await activity.sync([{ id: 'legacy', updatedAt: 'new', messageCount: 2 }], []);
  assert.deepEqual(loads, ['legacy']);
});
