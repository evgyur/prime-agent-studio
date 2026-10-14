// Pure three-way merge for roadmap documents (no I/O, no locks).
// Base is the last synced copy. Rules per element:
// - unchanged on one side takes the other side
// - changed on both takes the newest timestamp
// - present in base but removed on one side and unchanged on the other is removed
// - added on both sides keeps both
// Elements: plans by id (plan.updatedAt wins, steps travel with the plan,
// plan color travels with the plan), milestones by id (document lastEdit wins),
// overview.vision (document lastEdit wins), backlog items and notes matched by
// stable id with legacy fallback (number + addedAt).
// Order of plans, milestones and backlog: the newest document's order wins
// (see orderBy), so every PC converges on one sequence.
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (value) => structuredClone(value);
const timeOf = (value) => (Number.isSafeInteger(value) ? value : 0);
const docTime = (doc) => timeOf(doc?.lastEdit?.at);
const planTime = (plan) => timeOf(plan?.updatedAt);
const entryTime = (entry) => timeOf(entry?.updatedAt ?? entry?.addedAt);

// Newest wins with a side-independent tie break so both PCs converge.
function newest(local, remote, localTime, remoteTime) {
  if (localTime !== remoteTime) return localTime > remoteTime ? local : remote;
  return JSON.stringify(remote) >= JSON.stringify(local) ? remote : local;
}

// Each PC used to keep its own base order, so a reorder never propagated and
// two PCs could stay apart forever. The newest document's order wins instead,
// with the same side-independent tie break as newest(); entries it lacks follow
// by `fallback`. keysOf(entry) lists match keys, the first being the primary.
// ponytail: a reorder loses to a later edit made elsewhere before it arrived;
// add a dedicated order timestamp if that matters.
function orderBy(list, keysOf, localList, remoteList, localTime, remoteTime, fallback) {
  const primary = (entries) => entries.map((entry) => keysOf(entry)[0]);
  const winner =
    localTime !== remoteTime
      ? localTime > remoteTime
        ? localList
        : remoteList
      : JSON.stringify(primary(remoteList)) >= JSON.stringify(primary(localList))
        ? remoteList
        : localList;
  const rank = new Map();
  winner.forEach((entry, index) => {
    for (const key of keysOf(entry)) if (!rank.has(key)) rank.set(key, index);
  });
  const rankOf = (entry) => {
    for (const key of keysOf(entry)) if (rank.has(key)) return rank.get(key);
    return Infinity;
  };
  return [...list].sort((a, b) => rankOf(a) - rankOf(b) || fallback(a, b));
}

function emptyDocument() {
  return {
    schemaVersion: 1,
    revision: 0,
    lastEdit: { by: 'user', at: 0 },
    overview: { vision: '', milestones: [] },
    plans: [],
    backlog: { items: [], notes: [], nextNumber: 1 },
    pastudioImports: [],
  };
}

function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object') return emptyDocument();
  return {
    schemaVersion: 1,
    revision: Number.isSafeInteger(doc.revision) ? doc.revision : 0,
    lastEdit:
      doc.lastEdit && typeof doc.lastEdit === 'object'
        ? { ...doc.lastEdit, at: timeOf(doc.lastEdit.at) }
        : { by: 'user', at: 0 },
    overview: {
      vision: typeof doc.overview?.vision === 'string' ? doc.overview.vision : '',
      milestones: Array.isArray(doc.overview?.milestones) ? doc.overview.milestones : [],
    },
    plans: Array.isArray(doc.plans) ? doc.plans : [],
    backlog: {
      items: Array.isArray(doc.backlog?.items) ? doc.backlog.items : [],
      notes: Array.isArray(doc.backlog?.notes) ? doc.backlog.notes : [],
      nextNumber: Number.isSafeInteger(doc.backlog?.nextNumber) ? doc.backlog.nextNumber : 1,
    },
    pastudioImports: Array.isArray(doc.pastudioImports) ? doc.pastudioImports : [],
  };
}

// Merge one id-keyed list (plans, milestones).
// stampOf picks the conflict timestamp, orderNew sorts entries the winning
// order lacks; localTime/remoteTime pick that winning order (orderBy).
function mergeById(base, local, remote, { stampOf, orderNew, localTime = 0, remoteTime = 0 }) {
  const baseMap = new Map(base.map((e) => [e.id, e]));
  const localMap = new Map(local.map((e) => [e.id, e]));
  const remoteMap = new Map(remote.map((e) => [e.id, e]));
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const merged = new Map();
  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (!b) {
      if (l && r) merged.set(id, same(l, r) ? clone(l) : clone(newest(l, r, stampOf(l), stampOf(r))));
      else merged.set(id, clone(l ?? r));
    } else if (!l && !r) {
      // removed on both sides
    } else if (!l) {
      if (same(r, b)) {
        // removed locally, unchanged remotely: removed
      } else merged.set(id, clone(r));
    } else if (!r) {
      if (same(l, b)) {
        // removed remotely, unchanged locally: removed
      } else merged.set(id, clone(l));
    } else if (same(l, b)) merged.set(id, clone(r));
    else if (same(r, b)) merged.set(id, clone(l));
    else if (same(l, r)) merged.set(id, clone(l));
    else merged.set(id, clone(newest(l, r, stampOf(l), stampOf(r))));
  }
  const fallback = typeof orderNew === 'function' ? orderNew : (a, b) => String(a.id).localeCompare(String(b.id));
  return orderBy([...merged.values()], (e) => [e.id], local, remote, localTime, remoteTime, fallback);
}

const legacyKey = (entry) => `${entry.number}:${entry.addedAt}`;
const matchKeyOf = (entry) =>
  typeof entry?.id === 'string' && entry.id ? `id:${entry.id}` : `legacy:${legacyKey(entry)}`;

// Group backlog entries across base, local and remote so an entry that gained
// its stable id on one side still matches the legacy entry on the other side.
function groupBacklog(base, local, remote) {
  const groups = new Map();
  const byLegacy = new Map();
  const place = (docName, entry, kind) => {
    const legacy = `${entry.number}:${entry.addedAt}`;
    if (typeof entry.id === 'string' && entry.id) {
      const key = `id:${entry.id}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, id: entry.id, base: null, local: null, remote: null };
        groups.set(key, group);
      }
      group[docName] = { entry, kind };
      const known = byLegacy.get(legacy);
      if (!known) byLegacy.set(legacy, group);
      else if (known !== group && !known.mergedInto) {
        // Same logical entry, id on one side only: fold the legacy group in.
        for (const slot of ['base', 'local', 'remote']) {
          if (!group[slot] && known[slot]) group[slot] = known[slot];
        }
        known.mergedInto = group;
        groups.delete(known.key);
      }
    } else {
      const existing = byLegacy.get(legacy);
      if (existing && !existing.mergedInto) {
        if (!existing[docName]) existing[docName] = { entry, kind };
        else {
          const key = `legacy:${legacy}:${docName}`;
          let group = groups.get(key);
          if (!group) {
            group = { key, id: null, base: null, local: null, remote: null };
            groups.set(key, group);
          }
          group[docName] = { entry, kind };
        }
      } else {
        const key = `legacy:${legacy}`;
        let group = groups.get(key);
        if (!group) {
          group = { key, id: null, base: null, local: null, remote: null };
          groups.set(key, group);
          byLegacy.set(legacy, group);
        }
        if (!group[docName]) group[docName] = { entry, kind };
      }
    }
  };
  for (const entry of base.items) place('base', entry, 'item');
  for (const entry of base.notes) place('base', entry, 'note');
  for (const entry of local.items) place('local', entry, 'item');
  for (const entry of local.notes) place('local', entry, 'note');
  for (const entry of remote.items) place('remote', entry, 'item');
  for (const entry of remote.notes) place('remote', entry, 'note');
  return [...groups.values()];
}

function mergeBacklogGroups(groups) {
  const merged = [];
  for (const group of groups) {
    const b = group.base;
    const l = group.local;
    const r = group.remote;
    const pick = (slot) => (slot ? { entry: clone(slot.entry), kind: slot.kind } : null);
    if (!b) {
      if (l && r) {
        if (same({ ...l.entry, number: 0 }, { ...r.entry, number: 0 }) && l.kind === r.kind) {
          merged.push({ ...pick(l), wasSynced: false });
        } else if (l.kind === r.kind) {
          // Same logical entry added on both with different text: newest wins.
          const winner =
            entryTime(l.entry) !== entryTime(r.entry)
              ? newest(l, r, entryTime(l.entry), entryTime(r.entry))
              : newest(l, r, entryTime(l.entry), entryTime(r.entry));
          merged.push({ entry: clone(winner.entry), kind: winner.kind, wasSynced: false });
        } else {
          merged.push({ ...pick(l), wasSynced: false });
          merged.push({ ...pick(r), wasSynced: false });
        }
      } else merged.push({ ...pick(l ?? r), wasSynced: false });
    } else if (!l && !r) {
      // removed on both
    } else if (!l) {
      if (same(r.entry, b.entry) && r.kind === b.kind) {
        // removed locally, unchanged remotely
      } else merged.push({ ...pick(r), wasSynced: true });
    } else if (!r) {
      if (same(l.entry, b.entry) && l.kind === b.kind) {
        // removed remotely, unchanged locally
      } else merged.push({ ...pick(l), wasSynced: true });
    } else if (same(l.entry, b.entry) && l.kind === b.kind) {
      merged.push({ ...pick(r), wasSynced: true });
    } else if (same(r.entry, b.entry) && r.kind === b.kind) {
      merged.push({ ...pick(l), wasSynced: true });
    } else if (same(l.entry, r.entry) && l.kind === r.kind) {
      merged.push({ ...pick(l), wasSynced: true });
    } else if (l.kind !== r.kind && same({ ...l.entry }, { ...b.entry }) === false && same({ ...r.entry }, { ...b.entry }) === false) {
      // Both changed content and kind differs: newest entry wins with its kind.
      const winner = newest(l, r, entryTime(l.entry), entryTime(r.entry));
      merged.push({ entry: clone(winner.entry), kind: winner.kind, wasSynced: true });
    } else if (l.kind !== r.kind) {
      const winner = newest(l, r, entryTime(l.entry), entryTime(r.entry));
      merged.push({ entry: clone(winner.entry), kind: winner.kind, wasSynced: true });
    } else {
      const winner = newest(l.entry, r.entry, entryTime(l.entry), entryTime(r.entry));
      merged.push({ entry: clone(winner), kind: l.kind, wasSynced: true });
    }
  }
  return merged;
}

// Number collision: an entry that was already synced never moves. A new entry
// with the earliest addedAt keeps the number, others take nextNumber upwards.
function resolveBacklogNumbers(merged, baseNext) {
  const entries = merged.map((m) => m.entry);
  const maxNumber = entries.reduce((max, e) => Math.max(max, e.number || 0), 0);
  let next = Math.max(maxNumber + 1, Number.isSafeInteger(baseNext) ? baseNext : 1);
  const byNumber = new Map();
  for (const item of merged) {
    const list = byNumber.get(item.entry.number) ?? [];
    list.push(item);
    byNumber.set(item.entry.number, list);
  }
  for (const [, list] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length < 2) continue;
    list.sort((a, b) => {
      const synced = Number(!!b.wasSynced) - Number(!!a.wasSynced);
      if (synced) return synced;
      const at = (a.entry.addedAt || 0) - (b.entry.addedAt || 0);
      if (at) return at;
      return String(a.entry.id || '').localeCompare(String(b.entry.id || ''));
    });
    for (const extra of list.slice(1)) {
      extra.entry.number = next++;
    }
  }
  const finalMax = merged.reduce((max, m) => Math.max(max, m.entry.number || 0), 0);
  return Math.max(finalMax + 1, next, 1);
}

export function ensureBacklogIds(backlog, now = Date.now()) {
  let changed = false;
  for (const entries of [backlog.items, backlog.notes]) {
    for (const entry of entries) {
      if (typeof entry.id !== 'string' || !entry.id) {
        entry.id = `backlog-${randomUUID()}`;
        changed = true;
      }
      if (!Number.isSafeInteger(entry.updatedAt)) {
        entry.updatedAt = Number.isSafeInteger(entry.addedAt) ? entry.addedAt : now;
        changed = true;
      }
    }
  }
  return changed;
}

export function roadmapContentHash(doc) {
  const view = {
    schemaVersion: 1,
    overview: doc.overview,
    plans: doc.plans,
    backlog: doc.backlog,
    pastudioImports: doc.pastudioImports ?? [],
  };
  return createHash('sha256').update(JSON.stringify(view)).digest('hex');
}

export function mergeRoadmaps(baseInput, localInput, remoteInput) {
  const base = normalizeDoc(baseInput);
  const local = normalizeDoc(localInput);
  const remote = normalizeDoc(remoteInput);
  const localTime = docTime(local);
  const remoteTime = docTime(remote);

  let vision = base.overview.vision;
  if (local.overview.vision === remote.overview.vision) vision = local.overview.vision;
  else if (local.overview.vision === base.overview.vision) vision = remote.overview.vision;
  else if (remote.overview.vision === base.overview.vision) vision = local.overview.vision;
  else vision = newest(local.overview.vision, remote.overview.vision, localTime, remoteTime);

  const milestones = mergeById(base.overview.milestones, local.overview.milestones, remote.overview.milestones, {
    stampOf: () => 0,
    orderNew: (a, b) => String(a.id).localeCompare(String(b.id)),
    localTime,
    remoteTime,
  }).map((entry, _, list) => {
    void list;
    return entry;
  });
  // Milestone conflicts use document time: re-resolve both-changed ties here.
  // mergeById already handles it with stamp 0 plus JSON tie break; when both
  // sides changed and document times differ, prefer the newer document.
  const milestoneBase = new Map(base.overview.milestones.map((e) => [e.id, e]));
  const milestoneLocal = new Map(local.overview.milestones.map((e) => [e.id, e]));
  const milestoneRemote = new Map(remote.overview.milestones.map((e) => [e.id, e]));
  for (let i = 0; i < milestones.length; i++) {
    const id = milestones[i].id;
    const b = milestoneBase.get(id);
    const l = milestoneLocal.get(id);
    const r = milestoneRemote.get(id);
    if (b && l && r && !same(l, b) && !same(r, b) && !same(l, r) && localTime !== remoteTime) {
      milestones[i] = clone(localTime > remoteTime ? l : r);
    }
  }

  const plans = mergeById(base.plans, local.plans, remote.plans, {
    stampOf: (plan) => planTime(plan),
    orderNew: (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)),
    localTime,
    remoteTime,
  });

  const groups = groupBacklog(base.backlog, local.backlog, remote.backlog);
  const mergedEntries = mergeBacklogGroups(groups);
  const now = Math.max(localTime, remoteTime, Date.now());
  for (const item of mergedEntries) {
    if (typeof item.entry.id !== 'string' || !item.entry.id) item.entry.id = `backlog-${randomUUID()}`;
    if (!Number.isSafeInteger(item.entry.updatedAt))
      item.entry.updatedAt = Number.isSafeInteger(item.entry.addedAt) ? item.entry.addedAt : now;
  }
  const nextNumber = resolveBacklogNumbers(
    mergedEntries,
    Math.max(base.backlog.nextNumber, local.backlog.nextNumber, remote.backlog.nextNumber),
  );

  // Order: the newest document's sequence (orderBy); entries it lacks join by addedAt.
  const backlogKeys = (entry) =>
    typeof entry.id === 'string' && entry.id ? [matchKeyOf(entry), `legacy:${legacyKey(entry)}`] : [matchKeyOf(entry)];
  const orderedEntries = orderBy(
    mergedEntries,
    (m) => backlogKeys(m.entry),
    [...local.backlog.items, ...local.backlog.notes].map((entry) => ({ entry })),
    [...remote.backlog.items, ...remote.backlog.notes].map((entry) => ({ entry })),
    localTime,
    remoteTime,
    (a, b) =>
      (a.entry.addedAt || 0) - (b.entry.addedAt || 0) || String(a.entry.id || '').localeCompare(String(b.entry.id || '')),
  );
  const items = orderedEntries.filter((m) => m.kind !== 'note').map((m) => m.entry);
  const notes = orderedEntries.filter((m) => m.kind === 'note').map((m) => m.entry);

  const seenDigests = new Set();
  const pastudioImports = [];
  for (const entry of [...(local.pastudioImports ?? []), ...(remote.pastudioImports ?? [])]) {
    const digest = entry?.payloadDigest;
    if (typeof digest !== 'string' || seenDigests.has(digest)) continue;
    seenDigests.add(digest);
    pastudioImports.push(clone(entry));
  }

  const winner = localTime !== remoteTime ? (localTime > remoteTime ? local : remote) : null;
  const lastEdit = winner ? clone(winner.lastEdit) : clone(local.lastEdit);
  return {
    schemaVersion: 1,
    revision: Math.max(local.revision, remote.revision),
    lastEdit,
    overview: { vision, milestones },
    plans,
    backlog: { items, notes, nextNumber },
    pastudioImports,
  };
}
