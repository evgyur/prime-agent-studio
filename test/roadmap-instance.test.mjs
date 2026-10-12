// Roadmap multi-instance isolation (targeted, no browser, no model, no Studio).
// Covers contracts.md: N independent createRoadmap roots with unique ids/ARIA,
// CSS linked once, per-instance drafts/requests/editor, root+destroy/dispose,
// legacy primary defaults untouched. Backend revision-conflict safety is covered
// by test/roadmap.test.mjs ('two service instances refuse stale writes').
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// --- Minimal DOM stub (construction + open/close/destroy only) ---
const listeners = { document: new Map(), window: new Map() };
function track(map, type, fn) {
  if (!map.has(type)) map.set(type, new Set());
  map.get(type).add(fn);
}
function untrack(map, type, fn) {
  map.get(type)?.delete(fn);
}

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const n of names) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  toggle(name, force) {
    if (force === true) this.set.add(name);
    else if (force === false) this.set.delete(name);
    else this.set.has(name) ? this.set.delete(name) : this.set.add(name);
  }
  contains(name) { return this.set.has(name); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this._href = '';
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {
      setProperty: () => {},
      removeProperty: () => {},
    };
    this.classList = new FakeClassList();
    this.parentNode = null;
    this.parentElement = null;
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.textContent = '';
    this.value = '';
    this.isConnected = true;
    this.className = '';
    this.id = '';
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }
  get href() { return this._href; }
  set href(v) { this._href = String(v); this.attributes.set('href', String(v)); }
  append(...nodes) {
    for (const n of nodes.flat()) {
      if (n == null || n === false) continue;
      if (typeof n === 'string') continue; // text ignored by stub
      n.parentNode = this;
      n.parentElement = this;
      this.children.push(n);
    }
    return this;
  }
  appendChild(n) { return this.append(n); }
  replaceChildren(...nodes) {
    for (const c of this.children) { c.parentNode = null; c.parentElement = null; }
    this.children = [];
    if (nodes.length) this.append(...nodes);
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll(sel) {
    // Only construction-time queries matter here.
    if (sel === '.rm-menu[open]') return [];
    if (typeof sel === 'string' && sel.startsWith('link')) return [];
    return [];
  }
  querySelector(sel) {
    if (sel === '.app-shell') return null;
    if (sel === 'link[href="/public/roadmap.css"]') {
      return (
        this.children.find(
          (c) => c.href === '/public/roadmap.css' || c.getAttribute?.('href') === '/public/roadmap.css',
        ) || null
      );
    }
    return null;
  }
  contains() { return false; }
  closest() { return null; }
  getClientRects() { return []; }
  getBoundingClientRect() { return { top: 0, height: 0 }; }
  focus() {}
  click() {}
  remove() {
    if (this.parentNode?.children) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    }
    this.parentNode = null;
    this.parentElement = null;
    this.isConnected = false;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  dispatchEvent() { return true; }
}

function makeRoot() {
  const el = new FakeElement('root');
  el.appendChild = el.append.bind(el);
  return el;
}

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const head = makeRoot();
const body = makeRoot();
const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: (text) => ({ data: String(text), nodeType: 3, parentNode: null }),
  head,
  body,
  activeElement: null,
  hidden: false,
  addEventListener: (t, fn) => track(listeners.document, t, fn),
  removeEventListener: (t, fn) => untrack(listeners.document, t, fn),
  querySelector: () => null,
  getSelection: () => null,
};
const fakeWindow = {
  addEventListener: (t, fn) => track(listeners.window, t, fn),
  removeEventListener: (t, fn) => untrack(listeners.window, t, fn),
  innerWidth: 1600,
};

// localStorage must exist before import (i18n reads it at module top),
// but document/window must NOT: i18n.js initializes real DOM observers when
// globalThis.document exists, which a minimal stub cannot serve. roadmap.js
// only touches document inside createRoadmap, so install the stub after import.
globalThis.localStorage = fakeLocalStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
if (!globalThis.crypto?.randomUUID) {
  const { randomUUID } = await import('node:crypto');
  globalThis.crypto = { ...(globalThis.crypto || {}), randomUUID };
}

const { createRoadmap } = await import('../public/roadmap.js');

globalThis.document = fakeDocument;
globalThis.window = fakeWindow;
// roadmap.js reads bare innerWidth (browser global); mirror the stub viewport.
globalThis.innerWidth = 1600;
globalThis.innerHeight = 1000;
const source = await readFile(new URL('../public/roadmap.js', import.meta.url), 'utf8');

const baseOpts = (getContext) => ({
  api: async () => { throw Object.assign(new Error('no network in isolation'), { name: 'AbortError' }); },
  getContext,
  onOpenSession: async () => {},
  onWork: async () => {},
  onKnowledge: () => {},
  toast: () => {},
  onSummary: () => {},
});

const emptyCtx = () => ({ cwd: '', sessionId: '', readOnly: false, online: true, name: '', sessions: [] });

test('legacy primary defaults: exact ids, legacy draft key, destroy/dispose + root', () => {
  const view = createRoadmap(baseOpts(emptyCtx));
  try {
    assert.equal(view.instanceId, 'roadmap');
    assert.equal(view.isPrimary, true);
    assert.equal(view.panel.id, 'roadmap-panel');
    assert.equal(view.root, view.panel);
    assert.equal(view.panel.getAttribute('aria-labelledby'), 'roadmap-title');
    assert.equal(typeof view.destroy, 'function');
    assert.equal(typeof view.dispose, 'function');
    assert.equal(typeof view.refresh, 'function');
    assert.equal(typeof view.setDocked, 'function');
    assert.ok(body.children.includes(view.panel), 'primary panel mounted on body');
    // CSS linked once even after primary creation
    const links = head.children.filter(
      (c) => c.href === '/public/roadmap.css' || c.getAttribute?.('href') === '/public/roadmap.css',
    );
    assert.equal(links.length, 1);
  } finally {
    view.destroy();
  }
  assert.equal(body.children.length, 0, 'destroy removes primary panel+editor');
});

test('three instances: unique DOM roots, scoped ids/ARIA, CSS once', () => {
  const a = createRoadmap(baseOpts(emptyCtx)); // primary
  const b = createRoadmap({ ...baseOpts(emptyCtx), instanceId: 'tool:roadmap:AAA' });
  const c = createRoadmap({ ...baseOpts(emptyCtx), instanceId: 'tool:roadmap:BBB' });
  try {
    for (const v of [a, b, c]) assert.ok(v.panel !== undefined && v.editor !== undefined);
    assert.notEqual(a.panel, b.panel);
    assert.notEqual(b.panel, c.panel);
    assert.notEqual(a.editor, b.editor);
    // Unique panel ids + matching ARIA
    const ids = [a.panel.id, b.panel.id, c.panel.id];
    assert.deepEqual([...new Set(ids)].length, 3, `panel ids unique: ${ids}`);
    assert.equal(a.panel.id, 'roadmap-panel');
    assert.match(b.panel.id, /^roadmap-panel--/);
    assert.match(c.panel.id, /^roadmap-panel--/);
    for (const v of [a, b, c]) {
      const labelled = v.panel.getAttribute('aria-labelledby');
      assert.ok(labelled && labelled.length, 'aria-labelledby set');
    }
    assert.equal(b.panel.dataset.instanceId, 'tool:roadmap:AAA');
    assert.equal(c.panel.dataset.instanceId, 'tool:roadmap:BBB');
    assert.equal(b.panel.dataset.panelId, 'roadmap-panel');
    assert.equal(view_label(a), 'roadmap-title');
    assert.notEqual(view_label(b), view_label(c));
    // CSS still exactly once with 3 instances
    const links = head.children.filter(
      (el) => el.href === '/public/roadmap.css' || el.getAttribute?.('href') === '/public/roadmap.css',
    );
    assert.equal(links.length, 1, 'stylesheet linked once');
    // Per-instance editor ids unique where assigned
    const editorIds = [a.editor.id || '(legacy-none)', b.editor.id, c.editor.id];
    assert.notEqual(b.editor.id, c.editor.id, `editor ids unique: ${editorIds}`);
  } finally {
    b.destroy();
    // Destroying one sibling removes only its own nodes
    assert.ok(body.children.includes(a.panel), 'primary survives sibling destroy');
    assert.ok(body.children.includes(c.panel), 'other sibling survives');
    assert.ok(!body.children.includes(b.panel), 'destroyed sibling panel removed');
    a.dispose();
    c.dispose();
  }
  function view_label(v) { return v.panel.getAttribute('aria-labelledby'); }
});

test('per-instance draft namespace avoids sibling overwrite on same project', () => {
  assert.match(source, /studio\.roadmap\.draft:\$\{cwd\}:\$\{spec\.key\}/, 'primary keeps legacy draft key');
  assert.match(
    source,
    /studio\.roadmap\.draft:\$\{idToken\}:\$\{cwd\}:\$\{spec\.key\}/,
    'clones namespace drafts per instance with the full token',
  );
  assert.match(
    source,
    /encodeURIComponent\(rawInstanceId\)/,
    'token is injective and never truncated',
  );
});

test('long nonces stay unique: no 64-char truncation collisions', () => {
  const a = createRoadmap({ ...baseOpts(emptyCtx), instanceId: `tool:roadmap:${'A'.repeat(64)}X` });
  const b = createRoadmap({ ...baseOpts(emptyCtx), instanceId: `tool:roadmap:${'A'.repeat(64)}Y` });
  try {
    assert.notEqual(a.panel.id, b.panel.id, 'panel ids differ past char 64');
    assert.ok(a.panel.id.endsWith('X'), `ending preserved: ${a.panel.id.slice(-8)}`);
    assert.ok(b.panel.id.endsWith('Y'), `ending preserved: ${b.panel.id.slice(-8)}`);
    assert.notEqual(a.editor.id, b.editor.id, 'editor ids differ too');
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('captured OWN context: no fresh global read after await in actions', () => {
  assert.match(source, /const snapshotContext = \(\) => \(\{\s*\.\.\.getContext\(\)\s*\}\)/, 'snapshot helper present');
  assert.match(source, /const own = snapshotContext\(\);/, 'mutate captures own context');
  assert.match(source, /const context = snapshotContext\(\);/, 'work captures own context');
  assert.match(source, /const workCwd = cwd;/, 'work pins its own cwd');
  assert.match(source, /const ownCwd = cwd;/, 'openLink pins its own cwd');
  assert.match(source, /sessionId: own\.sessionId/, 'step.check stamps own session');
  assert.match(source, /await onWork\(result, context\)/, 'onWork carries captured context');
  assert.match(source, /onKnowledge\(snapshotContext\(\)\)/, 'onKnowledge carries own snapshot');
});

test('independence: document listeners cleaned, body chrome primary-only', () => {
  assert.match(source, /removeEventListener\('pointerdown', onPointerDown\)/, 'pointerdown cleaned');
  assert.match(source, /removeEventListener\('visibilitychange', update\)/, 'visibility cleaned');
  assert.match(source, /removeEventListener\('resize', onResize\)/, 'resize cleaned');
  assert.match(source, /offLanguage\?\.\(\)/, 'language listener cleaned');
  assert.match(source, /Secondary instances never own page chrome/, 'chrome ownership documented');
});

test('contract surface for parent coordinator is documented in source', () => {
  assert.match(source, /instanceId defaults to 'roadmap'/, 'default documented');
  assert.match(source, /tool:roadmap:<nonce>/, 'clone id format documented');
  assert.match(source, /view\.destroy\(\)\/view\.dispose\(\)/, 'teardown documented');
});

// --- Functional context/polling tests: stubbed GET doc, no network/Studio ---
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
function findAll(el, pred, out = []) {
  if (pred(el)) out.push(el);
  for (const c of el.children || []) findAll(c, pred, out);
  return out;
}
const makeDoc = (cwd) => ({
  cwd,
  revision: 1,
  instanceId: 'srv',
  activityRevision: 0,
  activity: [],
  initialized: true,
  name: 'P',
  linkWarnings: [],
  progress: { done: 0, total: 0, percent: 0 },
  overview: { vision: '', milestones: [], progress: { done: 0, total: 0, percent: 0 } },
  plans: [
    {
      id: 'p1',
      title: 'Plan',
      summary: '',
      status: 'active',
      archived: false,
      milestone: null,
      color: 'transparent',
      progress: { done: 0, total: 0, percent: 0 },
      sessions: [],
      journal: [],
      steps: [],
    },
  ],
  backlog: { items: [], notes: [] },
});
async function waitDoc(holder) {
  for (let i = 0; i < 400 && !holder.doc; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(holder.doc, 'stub doc loaded through refresh');
}

test('onKnowledge receives the OWN per-instance snapshot (back-compat extra arg)', async () => {
  const ctxA = {
    cwd: '/projA', name: 'A', sessions: [], sessionId: 'sess-A',
    model: 'mA', thinking: 'tA', readOnly: false, online: true,
  };
  const ctxB = {
    cwd: '/projB', name: 'B', sessions: [], sessionId: 'sess-B',
    model: 'mB', thinking: 'tB', readOnly: false, online: true,
  };
  const mk = (ctx, holder) => ({
    api: async () => makeDoc(ctx.cwd),
    getContext: () => ctx,
    onOpenSession: async () => {},
    onWork: async () => {},
    onKnowledge: (...args) => holder.calls.push(args),
    toast: () => {},
    onSummary: (doc) => { holder.doc = doc; },
  });
  const hA = { calls: [], doc: null };
  const hB = { calls: [], doc: null };
  const viewA = createRoadmap({ ...mk(ctxA, hA), instanceId: 'tool:roadmap:KA' });
  const viewB = createRoadmap({ ...mk(ctxB, hB), instanceId: 'tool:roadmap:KB' });
  try {
    viewA.open();
    viewB.open();
    await waitDoc(hA);
    await waitDoc(hB);
    // Footer is panel child #6; its first child is the knowledge button.
    const footerA = viewA.panel.children[5];
    assert.equal(footerA.children[0].tagName, 'BUTTON');
    footerA.children[0].onclick();
    assert.equal(hA.calls.length, 1, 'A handler fired once, B silent');
    assert.equal(hB.calls.length, 0);
    const snapshot = hA.calls[0][0];
    assert.equal(snapshot.cwd, '/projA');
    assert.equal(snapshot.sessionId, 'sess-A');
    assert.equal(snapshot.model, 'mA');
  } finally {
    viewA.destroy();
    viewB.destroy();
  }
});

test('onWork(result, context) pins origin across a POST delay (focus moves mid-flight)', async () => {
  let ctx = {
    cwd: '/projW', name: 'W', sessions: [], sessionId: 'sess-W',
    model: 'model-W', thinking: 'think-W', readOnly: false, online: true,
  };
  let postBody = null;
  let releasePost;
  const workCalls = [];
  const holder = { doc: null };
  const view = createRoadmap({
    api: async (url, opts) => {
      if (opts?.method === 'POST' && url === '/api/roadmap/work') {
        postBody = opts.body;
        await new Promise((r) => { releasePost = r; });
        return { sent: true };
      }
      return makeDoc('/projW');
    },
    getContext: () => ctx,
    onOpenSession: async () => {},
    onWork: (...args) => workCalls.push(args),
    onKnowledge: () => {},
    toast: () => {},
    onSummary: (doc) => { holder.doc = doc; },
  });
  try {
    view.open();
    await waitDoc(holder);
    const workBtns = findAll(
      view.panel,
      (el) => el.tagName === 'BUTTON' && String(el.className).includes('rm-work-button'),
    );
    assert.ok(workBtns.length >= 1, 'plan work button rendered');
    workBtns[0].onclick();
    const formEl = view.editor.children[0];
    assert.equal(formEl.tagName, 'FORM');
    const submitted = formEl.onsubmit({ preventDefault() {} });
    assert.ok(postBody, 'POST built before the delay');
    // Focus moves to another project/session while the POST is in flight.
    ctx = {
      cwd: '/other', name: 'O', sessions: [], sessionId: 'sess-OTHER',
      model: 'model-OTHER', thinking: 'think-OTHER', readOnly: false, online: true,
    };
    releasePost();
    await submitted;
    assert.equal(postBody.cwd, '/projW', 'POST kept origin cwd');
    assert.equal(postBody.model, 'model-W');
    assert.equal(postBody.sessionId, 'sess-W');
    assert.equal(workCalls.length, 1);
    assert.deepEqual(workCalls[0][0], { sent: true }, 'result stays 1st arg (legacy)');
    assert.equal(workCalls[0][1].cwd, '/projW', '2nd arg is the captured origin');
    assert.equal(workCalls[0][1].sessionId, 'sess-W');
    assert.equal(workCalls[0][1].model, 'model-W');
  } finally {
    view.destroy();
  }
});

test('hidden secondaries never poll; hidden primary keeps its summary GET', async () => {
  const counts = { primary: 0, clone: 0 };
  const live = { cwd: '/p', name: '', sessions: [], sessionId: '', readOnly: false, online: true };
  const mkApi = (key) => async (url, opts) => {
    if (opts?.method === 'POST') throw new Error('no writes in this test');
    counts[key]++;
    return makeDoc('/p');
  };
  const mkOpts = (key, extra = {}) => ({
    api: mkApi(key),
    getContext: () => live,
    onOpenSession: async () => {},
    onWork: async () => {},
    onKnowledge: () => {},
    toast: () => {},
    onSummary: () => {},
    ...extra,
  });
  const primary = createRoadmap(mkOpts('primary'));
  const clone = createRoadmap(mkOpts('clone', { instanceId: 'tool:roadmap:HID' }));
  try {
    primary.update();
    clone.update();
    await tick();
    assert.ok(counts.primary >= 1, `hidden primary summary GET fired (${counts.primary})`);
    assert.equal(counts.clone, 0, 'hidden secondary spent no GET');
    const frozen = counts.primary;
    primary.update();
    clone.update();
    await tick();
    assert.equal(counts.primary, frozen, 'primary summary stays throttled');
    assert.equal(counts.clone, 0, 'secondary still silent');
    // Visible clone polls again; re-hidden clone goes quiet.
    clone.update(); // syncs cwd while hidden (still no GET)
    await tick();
    assert.equal(counts.clone, 0);
    clone.setDocked({ visible: true });
    await tick();
    assert.ok(counts.clone >= 1, 'visible clone refreshes');
    const visibleCount = counts.clone;
    clone.setDocked({ visible: false });
    clone.update();
    await tick();
    assert.equal(counts.clone, visibleCount, 're-hidden clone silent again');
  } finally {
    primary.destroy();
    clone.destroy();
  }
});

test('onLanguageChange unsubscribe is a real function (destroy cleanup valid)', async () => {
  const { onLanguageChange } = await import('../public/i18n.js');
  let calls = 0;
  const off = onLanguageChange(() => calls++);
  assert.equal(typeof off, 'function', 'i18n returns an unregister function');
  off(); // must not throw; destroy() relies on it
});
