import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_KINDS } from '../public/docking-layout.js';
import {
  captureToolTarget,
  sameToolContext,
  resolveToolTarget,
  validateToolBindings,
  createToolViews,
  TOOL_STORAGE_KEY,
} from '../public/tool-views.js';

const make = () => {
  const a = {
    id: 'conversation',
    nonce: 'a',
    projectCwd: 'C:/A',
    execCwd: 'C:/A/worktree',
    sessionId: 'session-a',
  };
  const b = { id: 'conv:b', nonce: 'b', projectCwd: 'C:/B', sessionId: 'session-b' };
  const projects = [
    {
      cwd: 'C:/A',
      name: 'A',
      sessions: [{ id: 'session-a', title: 'Conversation A', cwd: 'C:/A/worktree' }],
    },
    { cwd: 'C:/B', name: 'B', sessions: [{ id: 'session-b', title: 'Conversation B' }] },
  ];
  return { a, b, snapshot: { focused: a, projects, views: [a, b], runs: [], ready: true } };
};

test('a tool follows focus until pinned, with the execution cwd of its owner', () => {
  const { a, b, snapshot } = make();
  const pin = captureToolTarget(a);
  snapshot.focused = b;
  assert.equal(resolveToolTarget(null, snapshot).sessionId, 'session-b');
  const locked = resolveToolTarget(pin, snapshot);
  assert.equal(locked.sessionId, 'session-a');
  assert.equal(locked.project.name, 'A');
  assert.equal(locked.execCwd, 'C:/A/worktree');
  assert.equal(locked.unavailable, false);
});

test('a pin stays live without its source tab and never follows a rebound view', () => {
  const { a, b, snapshot } = make();
  const pin = captureToolTarget(a);
  snapshot.views = [b];
  snapshot.focused = b;
  snapshot.projects[0].sessions[0].title = 'Updated A';
  const resolved = resolveToolTarget(pin, snapshot);
  assert.equal(resolved.view, null);
  assert.equal(resolved.session.title, 'Updated A');
  assert.equal(resolved.unavailable, false);
});

test('missing session/project is unavailable, with no active-conversation substitution', () => {
  const { a, b, snapshot } = make();
  const pin = captureToolTarget(a);
  snapshot.focused = b;
  snapshot.projects[0].sessions = [];
  assert.equal(resolveToolTarget(pin, snapshot).unavailable, true);
  snapshot.projects.shift();
  const result = resolveToolTarget(pin, snapshot);
  assert.equal(result.unavailable, true);
  assert.equal(result.sessionId, 'session-a');
  assert.equal(result.projectCwd, 'C:/A');
});

test('new-draft pin promotes only its own nonce and persists the assigned session', () => {
  const { a, b, snapshot } = make();
  a.sessionId = null;
  const pin = captureToolTarget(a);
  a.viewRunId = 'run-a';
  snapshot.runs.push({ id: 'run-a', cwd: a.execCwd, sessionId: 'session-new', status: 'running' });
  snapshot.projects[0].sessions.push({ id: 'session-new' });
  const next = resolveToolTarget(pin, snapshot);
  assert.equal(next.sessionId, 'session-new');
  assert.equal(next.promoted.sessionId, 'session-new');
  a.nonce = 'another-binding';
  a.sessionId = 'another-session';
  a.viewRunId = null;
  snapshot.focused = b;
  const missing = resolveToolTarget(pin, snapshot);
  assert.equal(missing.unavailable, true);
  assert.equal(missing.sessionId, null);
  assert.equal(missing.promoted, null);
});

test('Windows aliases match; POSIX case, root and absent project remain distinct', () => {
  const { a, snapshot } = make();
  const pin = captureToolTarget(a);
  pin.projectCwd = 'c:\\A\\';
  assert.equal(resolveToolTarget(pin, snapshot).unavailable, false);
  pin.projectCwd = '/A';
  snapshot.projects[0].cwd = '/a';
  assert.equal(resolveToolTarget(pin, snapshot).unavailable, true);
  snapshot.projects[0].cwd = '/';
  pin.projectCwd = '/';
  assert.equal(resolveToolTarget(pin, snapshot).project.cwd, '/');
});

test('restore strips content/permissions and keeps an unreadable pin locked', () => {
  const { a } = make();
  const validated = validateToolBindings({
    version: 1,
    entries: [
      {
        id: 'roadmap',
        locked: true,
        target: { ...captureToolTarget(a), readOnly: false, secret: 'x', history: ['private'] },
      },
      { id: 'tool:preferences:extra', locked: true, target: { projectCwd: 'C:/A' } },
    ],
  });
  assert.deepEqual(
    Object.keys(validated.entries[0].target).sort(),
    ['projectCwd', 'execCwd', 'sessionId', 'viewRunId', 'viewId', 'nonce'].sort(),
  );
  assert.equal(validated.entries[1].locked, true);
  assert.equal(validated.entries[1].target, null);
  assert.doesNotMatch(JSON.stringify(validated), /secret|private|readOnly/);
});

test('malformed, duplicated and unknown instance references are rejected', () => {
  for (const entries of [
    [{ id: '__proto__', locked: false }],
    [{ id: 'tool:unknown:x', locked: false }],
    [{ id: 'roadmap', locked: 'false' }],
    [
      { id: 'roadmap', locked: false },
      { id: 'roadmap', locked: true },
    ],
    Array.from({ length: 65 }, (_, i) => ({ id: `tool:files:v${i}`, locked: false })),
  ])
    assert.equal(validateToolBindings({ version: 1, entries }), null);
});

test('all tool kinds have independent locks; unlock resumes live focus', () => {
  const { a, b, snapshot } = make();
  const saved = new Map();
  const changed = [];
  const views = createToolViews({
    read: (k, fallback) => saved.get(k) ?? fallback,
    write: (k, value) => saved.set(k, structuredClone(value)),
    getSnapshot: () => snapshot,
    create: (entry) => ({ root: { id: entry.id }, ui: {} }),
    onChange: (entry) => changed.push(entry.id),
  });
  for (const kind of TOOL_KINDS) {
    const first = views.createView(kind),
      second = views.createView(kind);
    assert.notEqual(first.id, second.id);
    snapshot.focused = a;
    assert.equal(views.toggleLock(first.id), true);
    snapshot.focused = b;
    assert.equal(views.context(first.id).sessionId, 'session-a');
    assert.equal(views.context(second.id).sessionId, 'session-b');
    assert.equal(views.toggleLock(first.id), true);
    assert.equal(views.context(first.id).sessionId, 'session-b');
  }
  assert.equal(changed.length, TOOL_KINDS.length * 2);
  assert.equal(saved.get(TOOL_STORAGE_KEY).entries.length, TOOL_KINDS.length * 3);
  assert.equal('history' in saved.get(TOOL_STORAGE_KEY).entries[0], false);
});

test('Context lock keeps its conversation dossier target and becomes unavailable if removed', () => {
  const { a, b, snapshot } = make();
  const saved = new Map();
  const options = {
    read: (key, fallback) => saved.get(key) ?? fallback,
    write: (key, value) => saved.set(key, structuredClone(value)),
    getSnapshot: () => snapshot,
    create: (entry) => ({ root: { id: entry.id }, ui: {} }),
  };
  const views = createToolViews(options);
  assert.equal(views.entries.get('context').kind, 'context');
  views.toggleLock('context');
  const other = views.createView('context');
  snapshot.focused = b;
  assert.equal(views.context('context').sessionId, a.sessionId);
  assert.equal(views.context(other.id).sessionId, b.sessionId);
  const restored = createToolViews(options);
  assert.equal(restored.entries.get('context').locked, true);
  assert.equal(restored.context('context').sessionId, a.sessionId);
  snapshot.projects[0].sessions = [];
  snapshot.views = [b];
  assert.equal(restored.context('context').unavailable, true, 'Context must not substitute another dossier');
  restored.toggleLock('context');
  assert.equal(restored.context('context').sessionId, b.sessionId);
  assert.equal(restored.context('context').unavailable, false);
});

test('recovery of missing metadata is inert until explicit unlock, even after reload', () => {
  const { snapshot } = make();
  const saved = new Map();
  const options = {
    read: (k, fallback) => saved.get(k) ?? fallback,
    write: (k, value) => saved.set(k, structuredClone(value)),
    getSnapshot: () => snapshot,
    create: (entry) => ({ root: { id: entry.id } }),
  };
  const views = createToolViews(options);
  const restored = views.ensure('tool:files:lost', { restored: true });
  assert.equal(restored.locked, true);
  assert.equal(views.context(restored.id).unavailable, true);
  views.persist();
  const reloaded = createToolViews(options);
  assert.equal(reloaded.context(restored.id).unavailable, true);
  assert.equal(reloaded.toggleLock(restored.id), true);
  assert.equal(reloaded.context(restored.id).sessionId, 'session-a');
});

test('failed factories do not leave phantom instances', () => {
  const { snapshot } = make();
  const views = createToolViews({
    read: (_, fallback) => fallback,
    write() {},
    getSnapshot: () => snapshot,
    create() {
      throw new Error('broken factory');
    },
  });
  assert.throws(() => views.createView('files'), /broken factory/);
  assert.equal(views.entries.size, TOOL_KINDS.length);
});

test('late run creation promotes the submitted draft pin, not a rebound view or sibling', () => {
  const { a, b, snapshot } = make();
  a.sessionId = null;
  const views = createToolViews({
    read: (_, fallback) => fallback,
    write() {},
    getSnapshot: () => snapshot,
    create: (entry) => ({ root: { id: entry.id } }),
  });
  views.toggleLock('roadmap');
  snapshot.focused = b;
  views.toggleLock('files');
  a.nonce = 'unrelated';
  a.sessionId = 'unrelated';
  snapshot.runs.push({ id: 'new-run', cwd: 'C:/A/worktree', status: 'running', sessionId: 'session-new' });
  snapshot.projects[0].sessions.push({ id: 'session-new', title: 'Own new session' });
  views.bindDraftRun('conversation', 'a', snapshot.runs[0]);
  assert.equal(views.context('roadmap').sessionId, 'session-new');
  assert.equal(views.context('files').sessionId, 'session-b');
  assert.equal(views.entries.get('roadmap').target.viewRunId, 'new-run');
});

test('a full tool registry reopens a parked same-kind pin without stealing an open panel', () => {
  const { a, b, snapshot } = make();
  const entries = ['roadmap', 'session', 'agents', 'files', 'preferences'].map((id) => ({
    id,
    locked: false,
  }));
  entries.push({ id: 'tool:files:open', locked: false });
  entries.push({ id: 'tool:files:parked', locked: true, target: captureToolTarget(a) });
  for (let n = 0; n < 57; n++) entries.push({ id: `tool:roadmap:saved-${n}`, locked: false });
  snapshot.panelIds = ['conversation', 'tool:files:open'];
  snapshot.focused = b;
  const views = createToolViews({
    read: () => ({ version: 1, entries }),
    write() {},
    getSnapshot: () => snapshot,
    create: (entry) => ({ root: { id: entry.id } }),
  });
  assert.equal(views.entries.size, 64);
  const reopened = views.createView('files');
  assert.equal(reopened.id, 'tool:files:parked');
  assert.equal(views.context(reopened.id).sessionId, 'session-a');
  assert.equal(views.entries.get('tool:files:open').locked, false);
  snapshot.panelIds.push(reopened.id);
  assert.equal(views.createView('files'), null);
  assert.equal(views.entries.size, 64);
});

test('unreadable binding metadata keeps primary targets unavailable until explicit unlock', () => {
  const { snapshot } = make();
  const views = createToolViews({
    read: () => ({ invalid: true }),
    write() {},
    getSnapshot: () => snapshot,
    create: (entry) => ({ root: { id: entry.id } }),
  });
  for (const id of ['roadmap', 'session', 'agents', 'files', 'preferences']) {
    assert.equal(views.entries.get(id).locked, true);
    assert.equal(views.context(id).unavailable, true);
    assert.equal(views.toggleLock(id), true);
    assert.equal(views.context(id).sessionId, 'session-a');
  }
});

test('context openers distinguish same-project blank drafts and keep session identity after rebind', () => {
  const left = { projectCwd: 'C:/A', sessionId: null, view: { id: 'conversation', nonce: 'first' } };
  const right = { projectCwd: 'c:\\A', sessionId: null, view: { id: 'conv:b', nonce: 'second' } };
  assert.equal(sameToolContext(left, right), false);
  right.view = { ...left.view, nonce: 'rebound' };
  assert.equal(sameToolContext(left, right), false);
  right.view = { ...left.view };
  assert.equal(sameToolContext(left, right), true);
  left.run = { id: 'run-a' };
  right.run = { id: 'run-b' };
  assert.equal(sameToolContext(left, right), false);
  right.run.id = 'run-a';
  assert.equal(sameToolContext(left, right), true);
  left.sessionId = right.sessionId = 'session-a';
  left.view = null;
  right.view = { id: 'conv:elsewhere', nonce: 'new' };
  assert.equal(sameToolContext(left, right), true);
  right.unavailable = true;
  assert.equal(sameToolContext(left, right), false);
});

test('a pinned conversation follows the next live run, not its captured completed run', () => {
  const { a, snapshot } = make();
  a.viewRunId = 'old-run';
  const pin = captureToolTarget(a);
  snapshot.runs = [
    { id: 'old-run', sessionId: 'session-a', cwd: a.execCwd, status: 'done' },
    { id: 'new-run', sessionId: 'session-a', cwd: a.execCwd, status: 'running' },
  ];
  assert.equal(resolveToolTarget(pin, snapshot).run.id, 'new-run');
  snapshot.runs[1].status = 'done';
  assert.equal(resolveToolTarget(pin, snapshot).run, null);
  snapshot.projects[0].sessions = [];
  assert.equal(resolveToolTarget(pin, snapshot).unavailable, true);
});

test('a just-allocated session pin stays live until its first history file is indexed', () => {
  const { a, snapshot } = make();
  a.sessionId = null;
  a.viewRunId = 'fresh-run';
  const pin = captureToolTarget(a);
  snapshot.runs = [{ id: 'fresh-run', sessionId: 'fresh-session', cwd: a.execCwd, status: 'running' }];
  const live = resolveToolTarget(pin, snapshot);
  assert.equal(live.sessionId, 'fresh-session');
  assert.equal(live.unavailable, false);
  assert.equal(live.promoted.sessionId, 'fresh-session');
  snapshot.views = [];
  assert.equal(resolveToolTarget(live.promoted, snapshot).unavailable, false);
  snapshot.runs[0].cwd = 'C:/B';
  assert.equal(resolveToolTarget(live.promoted, snapshot).unavailable, true);
  snapshot.runs[0].cwd = a.execCwd;
  snapshot.runs[0].status = 'done';
  assert.equal(resolveToolTarget(live.promoted, snapshot).unavailable, true);
});

test('a finished run without a session or its original draft is unavailable, not a new-conversation substitute', () => {
  const { a, b, snapshot } = make();
  a.sessionId = null;
  a.viewRunId = 'failed-draft';
  const pin = captureToolTarget(a);
  snapshot.runs = [{ id: 'failed-draft', cwd: a.execCwd, status: 'failed' }];
  assert.equal(
    resolveToolTarget(pin, snapshot).unavailable,
    false,
    'Original retained draft still owns the failed run',
  );
  snapshot.views = [b];
  snapshot.focused = b;
  assert.equal(resolveToolTarget(pin, snapshot).unavailable, true);
  assert.equal(resolveToolTarget(pin, snapshot).projectCwd, 'C:/A');
  assert.equal(resolveToolTarget(pin, snapshot).sessionId, null);
  snapshot.runs[0].status = 'running';
  snapshot.runs[0].cwd = 'C:/B';
  assert.equal(
    resolveToolTarget(pin, snapshot).unavailable,
    true,
    'A foreign run cannot supply an orphaned draft target',
  );
});


test('Performance keeps its pinned project after its source session is removed', () => {
  const { b, snapshot } = make();
  const views = createToolViews({ read: (_, fallback) => fallback, write() {}, getSnapshot: () => snapshot, create: () => ({ root: {} }) });
  const entry = views.createView('performance');
  assert.equal(views.toggleLock(entry.id), true);
  snapshot.focused = b;
  snapshot.projects[0].sessions = [];
  snapshot.views = [b];
  assert.equal(views.context(entry.id).project.name, 'A');
  assert.equal(views.context(entry.id).unavailable, false);
  snapshot.projects.shift();
  assert.equal(views.context(entry.id).unavailable, true);
});
