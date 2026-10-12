import test from 'node:test';
import assert from 'node:assert/strict';
import { historyPageUrl, prependHistoryPage, fetchRecentHistory } from '../public/history-pages.js';
const message = (id, text = id) => ({ id, role: 'assistant', text, tools: [] });
const page = (ids, start, total, cursor = 'before') => ({
  id: 's',
  title: 'Session',
  messages: ids.map((id) => message(id)),
  readState: { answer: ids.at(-1) },
  historyPage: {
    total,
    limit: 80,
    start,
    end: start + ids.length,
    hasBefore: start > 0,
    beforeCursor: start ? cursor : null,
  },
});

test('UI page URL requests bounded tail and safely encodes owner/cursor', () => {
  const url = new URL(historyPageUrl('a&b', 'x/y+z='), 'http://localhost');
  assert.equal(url.searchParams.get('id'), 'a&b');
  assert.equal(url.searchParams.get('limit'), '80');
  assert.equal(url.searchParams.get('before'), 'x/y+z=');
});

test('detached refresh updates the entire retained range, not a stale cached prefix', async () => {
  const previous = page(['a', 'b', 'c'], 0, 3);
  const changed = page(['a', 'b'], 0, 4);
  changed.messages[0].text = 'changed earlier';
  const replies = [page(['c', 'd'], 2, 4), changed];
  const joined = await fetchRecentHistory(async () => replies.shift(), 's', previous, {
    preserveReading: true,
  });
  assert.deepEqual(
    joined.messages.map((m) => m.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(joined.messages[0].text, 'changed earlier');
  assert.equal(previous.messages[0].text, 'a');
});

test('legacy complete snapshots and empty histories remain complete', async () => {
  for (const fresh of [{ messages: [message('z')] }, page([], 0, 0)]) {
    const joined = await fetchRecentHistory(async () => fresh, 's', page(['a', 'b'], 0, 2), {
      preserveReading: true,
    });
    assert.equal(joined, fresh);
  }
});

test('older pages prepend once, preserve current tail receipt and do not mutate inputs', () => {
  const current = page(['b', 'c'], 4, 6, 'b');
  const older = page(['a', 'b'], 3, 7, 'a');
  const joined = prependHistoryPage(current, older);
  assert.deepEqual(
    joined.messages.map((m) => m.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(joined.readState, current.readState);
  assert.equal(joined.historyPage.beforeCursor, 'a');
  assert.deepEqual(
    current.messages.map((m) => m.id),
    ['b', 'c'],
  );
});

test('initial/tail-follow opens only latest page even when previous data has a gap', async () => {
  const calls = [],
    fresh = page(['f', 'g'], 5, 7);
  const result = await fetchRecentHistory(
    async (url) => {
      calls.push(url);
      return fresh;
    },
    's',
    page(['a', 'b'], 0, 2),
  );
  assert.equal(result, fresh);
  assert.equal(calls.length, 1);
});

test('reading an older position fills the missing range without dropping or duplicating messages', async () => {
  const previous = page(['a', 'b'], 0, 2);
  const replies = [
    page(['f', 'g'], 5, 7, 'f'),
    page(['d', 'e'], 3, 7, 'd'),
    page(['b', 'c'], 1, 7, 'b'),
    page(['a'], 0, 7),
  ];
  const calls = [];
  const result = await fetchRecentHistory(
    async (url) => {
      calls.push(url);
      return replies.shift();
    },
    's',
    previous,
    { preserveReading: true },
  );
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  );
  assert.equal(result.historyPage.hasBefore, false);
  assert.equal(calls.length, 4);
});

test('stale source during gap recovery refetches current tail rather than merging old history', async () => {
  const fresh = page(['z'], 0, 1);
  let calls = 0;
  const result = await fetchRecentHistory(
    async () => {
      calls++;
      if (calls === 1) return page(['f'], 5, 6);
      if (calls === 2) throw Object.assign(Error('stale'), { status: 409 });
      return fresh;
    },
    's',
    page(['a'], 0, 1),
    { preserveReading: true },
  );
  assert.equal(result, fresh);
  assert.equal(calls, 3);
});

test('navigation cancellation does not continue fetching old pages', async () => {
  let calls = 0;
  const fresh = page(['f'], 5, 6);
  await assert.rejects(
    fetchRecentHistory(
      async () => {
        calls++;
        return fresh;
      },
      's',
      page(['a'], 0, 1),
      { preserveReading: true, isCurrent: () => false },
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('detached refresh keeps its exact first boundary and reuses the append-safe cursor', async () => {
  const previous = page(['c', 'd'], 2, 4, 'cursor-c');
  const replies = [page(['e', 'f'], 4, 6, 'cursor-e'), page(['a', 'b', 'c', 'd'], 0, 6)];
  const result = await fetchRecentHistory(async () => replies.shift(), 's', previous, {
    preserveReading: true,
  });
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ['c', 'd', 'e', 'f'],
  );
  assert.equal(result.historyPage.start, 2);
  assert.equal(result.historyPage.beforeCursor, 'cursor-c');
  assert.equal(result.historyPage.hasBefore, true);
});
