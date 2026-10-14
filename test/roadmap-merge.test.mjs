import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRoadmaps, roadmapContentHash, ensureBacklogIds } from '../lib/roadmap-merge.mjs';

const at = (n) => n;
function doc(over = {}) {
  return {
    schemaVersion: 1,
    revision: over.revision ?? 1,
    lastEdit: { by: 'user', at: over.at ?? 1000 },
    overview: { vision: over.vision ?? '', milestones: over.milestones ?? [] },
    plans: over.plans ?? [],
    backlog: over.backlog ?? { items: [], notes: [], nextNumber: 1 },
    pastudioImports: over.pastudioImports ?? [],
  };
}
const plan = (id, over = {}) => ({
  id,
  slug: `${id}-slug`,
  title: over.title ?? id,
  summary: '',
  status: 'active',
  milestone: null,
  sessions: [],
  steps: over.steps ?? [],
  journal: [],
  createdAt: over.createdAt ?? 100,
  updatedAt: over.updatedAt ?? 100,
  archived: false,
  archivedAt: null,
  ...(over.color ? { color: over.color } : {}),
});
const entry = (number, over = {}) => ({
  number,
  text: over.text ?? `entry ${number}`,
  note: '',
  ...(over.kind === 'note' ? {} : { done: false }),
  addedAt: over.addedAt ?? 1000 + number,
  ...(over.id ? { id: over.id } : {}),
  ...(over.updatedAt ? { updatedAt: over.updatedAt } : {}),
  by: 'user',
  sessions: [],
});

test('one-sided edits win on each side', () => {
  const base = doc({ vision: 'v0', plans: [plan('plan-a', { title: 'A' })], at: 1000 });
  const local = doc({
    vision: 'v-local',
    plans: [plan('plan-a', { title: 'A' }), plan('plan-b', { title: 'B', createdAt: 200, updatedAt: 200 })],
    at: 2000,
  });
  const remote = doc({
    vision: 'v0',
    plans: [plan('plan-a', { title: 'A remote', updatedAt: 1500 })],
    at: 1500,
  });
  const merged = mergeRoadmaps(base, local, remote);
  assert.equal(merged.overview.vision, 'v-local');
  assert.equal(merged.plans.find((p) => p.id === 'plan-a').title, 'A remote');
  assert.ok(merged.plans.some((p) => p.id === 'plan-b'));
});

test('both sides changed takes the newest plan timestamp', () => {
  const base = doc({ plans: [plan('plan-a', { title: 'A', updatedAt: 100 })] });
  const local = doc({ plans: [plan('plan-a', { title: 'A local', updatedAt: 2000 })], at: 2000 });
  const remote = doc({ plans: [plan('plan-a', { title: 'A remote', updatedAt: 3000 })], at: 3000 });
  assert.equal(mergeRoadmaps(base, local, remote).plans[0].title, 'A remote');
  assert.equal(mergeRoadmaps(base, remote, local).plans[0].title, 'A remote');
});

test('vision conflict takes the newest document', () => {
  const base = doc({ vision: 'v0', at: 1000 });
  const local = doc({ vision: 'v-local', at: 2000 });
  const remote = doc({ vision: 'v-remote', at: 3000 });
  assert.equal(mergeRoadmaps(base, local, remote).overview.vision, 'v-remote');
  assert.equal(mergeRoadmaps(base, remote, local).overview.vision, 'v-remote');
});

test('deletion wins when the other side is unchanged, change beats deletion', () => {
  const base = doc({ plans: [plan('plan-a'), plan('plan-b')] });
  const removedLocally = doc({ plans: [plan('plan-b')] });
  const untouched = doc({ plans: [plan('plan-a'), plan('plan-b')] });
  assert.deepEqual(
    mergeRoadmaps(base, removedLocally, untouched).plans.map((p) => p.id),
    ['plan-b'],
  );
  const changedRemotely = doc({ plans: [plan('plan-a', { title: 'changed', updatedAt: 5000 }), plan('plan-b')] });
  const merged = mergeRoadmaps(base, removedLocally, changedRemotely);
  assert.equal(merged.plans.find((p) => p.id === 'plan-a').title, 'changed');
});

test('entries added on both sides are all kept', () => {
  const base = doc({});
  const local = doc({ plans: [plan('plan-a', { createdAt: 10, updatedAt: 10 })] });
  const remote = doc({ plans: [plan('plan-b', { createdAt: 20, updatedAt: 20 })] });
  const merged = mergeRoadmaps(base, local, remote);
  assert.deepEqual(
    merged.plans.map((p) => p.id).sort(),
    ['plan-a', 'plan-b'],
  );
});

test('plan color travels with the plan and resets', () => {
  const base = doc({ plans: [plan('plan-a', { updatedAt: 100 })] });
  const colored = doc({ plans: [plan('plan-a', { updatedAt: 200, color: '#0d9488' })], at: 200 });
  const merged = mergeRoadmaps(base, colored, doc({ plans: [plan('plan-a', { updatedAt: 100 })], at: 100 }));
  assert.equal(merged.plans[0].color, '#0d9488');
  const reset = doc({ plans: [{ ...plan('plan-a', { updatedAt: 300 }) }], at: 300 });
  delete reset.plans[0].color;
  const merged2 = mergeRoadmaps(base, colored, reset);
  assert.equal(merged2.plans[0].color, undefined);
});

test('backlog number collision keeps the earliest addedAt', () => {
  const base = doc({ backlog: { items: [], notes: [], nextNumber: 1 } });
  const local = doc({
    backlog: { items: [entry(1, { id: 'backlog-l', text: 'local', addedAt: 2000 })], notes: [], nextNumber: 2 },
  });
  const remote = doc({
    backlog: { items: [entry(1, { id: 'backlog-r', text: 'remote', addedAt: 1000 })], notes: [], nextNumber: 2 },
  });
  const merged = mergeRoadmaps(base, local, remote);
  const byId = new Map(merged.backlog.items.map((e) => [e.id, e]));
  assert.equal(byId.get('backlog-r').number, 1);
  assert.notEqual(byId.get('backlog-l').number, 1);
  assert.equal(merged.backlog.nextNumber, 3);
  assert.deepEqual(
    merged.backlog.items.map((e) => e.number).sort((a, b) => a - b),
    [1, 2],
  );
});

test('synced entries never move on collision', () => {
  const synced = entry(1, { id: 'backlog-s', text: 'synced', addedAt: 1000 });
  const base = doc({ backlog: { items: [synced], notes: [], nextNumber: 2 } });
  const local = doc({ backlog: { items: [synced], notes: [], nextNumber: 2 } });
  const remote = doc({
    backlog: {
      items: [synced, entry(1, { id: 'backlog-new', text: 'new', addedAt: 500 })],
      notes: [],
      nextNumber: 2,
    },
  });
  const merged = mergeRoadmaps(base, local, remote);
  assert.equal(merged.backlog.items.find((e) => e.id === 'backlog-s').number, 1);
  assert.notEqual(merged.backlog.items.find((e) => e.id === 'backlog-new').number, 1);
});

test('legacy entries without id match by number and addedAt', () => {
  const legacy = { number: 1, text: 'legacy', note: '', done: false, addedAt: 1000, by: 'user', sessions: [] };
  const base = doc({ backlog: { items: [legacy], notes: [], nextNumber: 2 } });
  const local = doc({
    backlog: { items: [{ ...legacy, text: 'legacy edited', updatedAt: 2000 }], notes: [], nextNumber: 2 },
    at: 2000,
  });
  const remote = doc({ backlog: { items: [legacy], notes: [], nextNumber: 2 }, at: 1000 });
  const merged = mergeRoadmaps(base, local, remote);
  assert.equal(merged.backlog.items.length, 1);
  assert.equal(merged.backlog.items[0].text, 'legacy edited');
  assert.ok(typeof merged.backlog.items[0].id === 'string');
});

test('content hash ignores revision and lastEdit', () => {
  const a = doc({ vision: 'same', revision: 1, at: 1000 });
  const b = doc({ vision: 'same', revision: 9, at: 9000 });
  assert.equal(roadmapContentHash(a), roadmapContentHash(b));
});

test('ensureBacklogIds fills stable ids lazily', () => {
  const backlog = { items: [{ number: 1, addedAt: 1000 }], notes: [], nextNumber: 2 };
  assert.equal(ensureBacklogIds(backlog, 5000), true);
  assert.ok(backlog.items[0].id.startsWith('backlog-'));
  assert.equal(backlog.items[0].updatedAt, 1000);
  assert.equal(ensureBacklogIds(backlog, 5000), false);
});

test('backlog order converges when two PCs hold the same entries in different orders', () => {
  const items = [1, 2, 3, 4].map((n) => entry(n, { id: `b-${n}`, updatedAt: 1000 + n }));
  const pick = (...numbers) => numbers.map((n) => structuredClone(items[n - 1]));
  // Each PC's base is its own last synced copy (the real situation): same time, different order.
  const x = doc({ at: 5000, backlog: { items: pick(1, 2, 3, 4), notes: [], nextNumber: 5 } });
  const y = doc({ at: 5000, backlog: { items: pick(2, 3, 1, 4), notes: [], nextNumber: 5 } });
  const onX = mergeRoadmaps(x, x, y);
  const onY = mergeRoadmaps(y, y, x);
  const order = (d) => d.backlog.items.map((e) => e.number);
  assert.deepEqual(order(onX), order(onY), 'both PCs pick the same order');
  assert.equal(roadmapContentHash(onX), roadmapContentHash(onY), 'identical documents');
  // Stable: merging again changes nothing.
  assert.deepEqual(order(mergeRoadmaps(onX, onX, onY)), order(onX));
});

test('a backlog reorder on the newer document propagates', () => {
  const items = [1, 2, 3].map((n) => entry(n, { id: `b-${n}`, updatedAt: 1000 + n }));
  const base = doc({ at: 1000, backlog: { items: structuredClone(items), notes: [], nextNumber: 4 } });
  const moved = doc({ at: 2000, backlog: { items: structuredClone([items[2], items[0], items[1]]), notes: [], nextNumber: 4 } });
  const merged = mergeRoadmaps(base, base, moved);
  assert.deepEqual(merged.backlog.items.map((e) => e.number), [3, 1, 2]);
  // An entry added on the older side joins after the winning order.
  const added = entry(9, { id: 'b-9', addedAt: 3000, updatedAt: 3000 });
  const local = doc({ at: 1500, backlog: { items: [...structuredClone(items), added], notes: [], nextNumber: 10 } });
  assert.deepEqual(mergeRoadmaps(base, local, moved).backlog.items.map((e) => e.number), [3, 1, 2, 9]);
});

test('a plan reorder on the newer document propagates', () => {
  const plans = ['plan-a', 'plan-b', 'plan-c'].map((id) => plan(id));
  const base = doc({ at: 1000, plans: structuredClone(plans) });
  const moved = doc({ at: 2000, plans: structuredClone([plans[1], plans[2], plans[0]]) });
  assert.deepEqual(mergeRoadmaps(base, base, moved).plans.map((p) => p.id), ['plan-b', 'plan-c', 'plan-a']);
  assert.deepEqual(mergeRoadmaps(base, moved, base).plans.map((p) => p.id), ['plan-b', 'plan-c', 'plan-a']);
});
