// First-click gesture safety: pointerdown-initiated activation switches focus
// state synchronously but defers the transcript paint past gesture end, so the
// browser keeps the trusted click (focus AND single open). Explicit and
// programmatic focus render synchronously. Minimal DOM stub; no browser.
import test from 'node:test';
import assert from 'node:assert/strict';

function makeEl(tag = 'div') {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    get firstChild() {
      return this.childNodes[0] || null;
    },
    dataset: {},
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    type: '',
    rows: 2,
    spellcheck: false,
    className: '',
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    parentNode: null,
    _listeners: {},
    classList: { add() {}, toggle() {}, contains: () => false },
    append(...nodes) {
      for (const n of nodes.flat()) {
        if (n == null || n === false) continue;
        this.childNodes.push(n);
        if (n && typeof n === 'object') n.parentNode = this;
      }
      return this;
    },
    appendChild(n) {
      return this.append(n);
    },
    replaceChildren(...nodes) {
      this.childNodes = nodes.flat().filter((n) => n != null && n !== false);
      for (const n of this.childNodes) if (n && typeof n === 'object') n.parentNode = this;
    },
    before() {},
    after() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this._listeners[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getClientRects() {
      return [];
    },
    cloneNode() {
      return makeEl(tag);
    },
    closest() {
      return null;
    },
    scrollTo() {},
    scrollIntoView() {},
    focus() {},
  };
  return el;
}

const docListeners = {};
const hostEl = makeEl('div');
hostEl.className = 'conversation-column';
const bodyEl = makeEl('body');
globalThis.document = {
  documentElement: makeEl('html'),
  querySelector(sel) {
    return sel === '.conversation-column' ? hostEl : null;
  },
  querySelectorAll() {
    return [];
  },
  createElement(tag) {
    return makeEl(tag);
  },
  createComment() {
    return makeEl('#comment');
  },
  createTextNode(text) {
    return { nodeType: 3, data: String(text), parentNode: null };
  },
  createTreeWalker() {
    return { nextNode: () => null };
  },
  body: bodyEl,
  getElementById() {
    return makeEl('div');
  },
  addEventListener(type, fn) {
    (docListeners[type] ||= []).push(fn);
  },
  removeEventListener(type, fn) {
    const list = docListeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
};
const winListeners = {};
globalThis.window = {
  addEventListener(type, fn) {
    (winListeners[type] ||= []).push(fn);
  },
  removeEventListener(type, fn) {
    const list = winListeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.NodeFilter = { SHOW_ALL: 4294967295 };
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.Option = class {
  constructor(label = '', value = '') {
    this.label = label;
    this.value = value;
    this.selected = false;
  }
};
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
}

const { createConversationViews, PRIMARY_VIEW_ID } = await import('../public/conversation-views.js');

function makeHarness() {
  const calls = { hostRender: 0, mirror: 0 };
  const store = {};
  const stubNode = () => makeEl('div');
  const cv = createConversationViews({
    read: (k, fb) => (k in store ? store[k] : fb),
    write: (k, v) => {
      store[k] = v;
    },
    getDocking: () => ({
      getLayout: () => null,
      registerPanel() {},
      refreshTitles() {},
      visiblePanels: () => [],
      openPanel() {},
    }),
    renderer: {
      icon: stubNode,
      markdown: stubNode,
      renderMessage: stubNode,
      renderTool: stubNode,
      makeDetails: stubNode,
      dateLabel: () => '',
      copyText() {},
      reasoningMode: () => 'hidden',
    },
    getRun: () => null,
    isRunActive: () => false,
    describeRun: () => null,
    getSessionTitle: () => '',
    getHostText: () => '',
    setHostText() {},
    afterTextRestore() {},
    getControls: () => ({ model: '', thinking: '', allowQuestions: true }),
    hostRender: () => {
      calls.hostRender += 1;
    },
    historyRenderOptions: () => ({}),
    renderNavigation() {},
    saveSelection() {},
    peekImages: () => ({ count: 0, pending: 0, loading: false }),
    onToast() {},
    afterFocus() {},
    clearHostNodes() {},
    isReadOnly: () => true,
    getHostScrollState: () => ({ top: 0, follow: true }),
    restoreHostScrollState() {},
    paintViewChrome() {},
    markSessionRead() {},
    welcomeProjectText: () => '',
    mirrorToGlobal: () => {
      calls.mirror += 1;
    },
  });
  return { cv, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const primaryPointerdown = { button: 0, pointerType: 'mouse' };

test('pointerdown activation defers paint, click flushes it on the next task', async () => {
  const { cv, calls } = makeHarness();
  const second = cv.createView({ kind: 'new', projectCwd: null });
  assert.ok(second, 'second pane created');
  cv.bindHost();
  const shellDown = second.shell.root._listeners.pointerdown;
  assert.ok(shellDown?.length, 'shell pointerdown bound');
  const base = calls.hostRender;
  shellDown[0](primaryPointerdown);
  assert.equal(cv.focusedId(), second.id, 'focus state switches synchronously');
  assert.equal(calls.hostRender, base, 'no synchronous paint during the gesture');
  assert.equal(docListeners.click?.length, 1, 'one-shot click flush armed');
  // Browser dispatches the trusted click; target handlers run before the flush.
  for (const fn of [...(docListeners.click || [])]) fn({});
  assert.equal(calls.hostRender, base, 'flush never runs inside dispatch');
  await tick();
  await tick();
  assert.equal(calls.hostRender, base + 1, 'paint flushes once on the next task');
});

test('pointerup flushes on the next task; a real click collapses to one paint', async () => {
  const { cv, calls } = makeHarness();
  const second = cv.createView({ kind: 'new', projectCwd: null });
  second.shell.root._listeners.pointerdown[0](primaryPointerdown);
  const base = calls.hostRender;
  for (const fn of [...(winListeners.pointerup || [])]) fn({ button: 0, pointerType: 'mouse' });
  assert.equal(calls.hostRender, base, 'no sync paint on pointerup');
  // Trusted click still dispatches afterwards: it collapses the queued flush.
  for (const fn of [...(docListeners.click || [])]) fn({});
  await tick();
  await tick();
  assert.equal(calls.hostRender, base + 1, 'exactly one post-click paint');
});

test('non-primary pointerup never flushes a queue it did not arm', async () => {
  const { cv, calls } = makeHarness();
  const second = cv.createView({ kind: 'new', projectCwd: null });
  second.shell.root._listeners.pointerdown[0](primaryPointerdown);
  const base = calls.hostRender;
  for (const fn of [...(winListeners.pointerup || [])]) fn({ button: 2, pointerType: 'mouse' });
  await tick();
  await tick();
  assert.equal(calls.hostRender, base, 'right-button release leaves the click flush armed');
  for (const fn of [...(docListeners.click || [])]) fn({});
  await tick();
  await tick();
  assert.equal(calls.hostRender, base + 1, 'original gesture still paints once');
});

test('explicit focus renders synchronously and drops any queued paint', async () => {
  const { cv, calls } = makeHarness();
  const second = cv.createView({ kind: 'new', projectCwd: null });
  const shellDown = second.shell.root._listeners.pointerdown;
  shellDown[0](primaryPointerdown);
  const base = calls.hostRender;
  // Programmatic activation while a gesture paint is queued paints once, sync.
  cv.focusView(PRIMARY_VIEW_ID);
  assert.equal(cv.focusedId(), PRIMARY_VIEW_ID);
  assert.equal(calls.hostRender, base + 1, 'single sync paint, no double flush');
  await tick();
  await tick();
  assert.equal(calls.hostRender, base + 1, 'no stray flush afterwards');
});

test('bindFocused clears a queued gesture paint (its own sync paint covers)', async () => {
  const { cv, calls } = makeHarness();
  const second = cv.createView({ kind: 'new', projectCwd: null });
  second.shell.root._listeners.pointerdown[0](primaryPointerdown);
  const base = calls.hostRender;
  cv.bindFocused({ kind: 'session', sessionId: 'S1', projectCwd: null });
  assert.equal(calls.hostRender, base + 1, 'exactly the sync rebind paint');
  await tick();
  await tick();
  assert.equal(calls.hostRender, base + 1, 'queued paint dropped, never doubled');
});

test('classic host never steals a retained secondary focus', () => {
  const { cv, calls } = makeHarness();
  hostEl.dataset.cvwActive = '';
  hostEl._listeners = {};
  cv.bindHost();
  const second = cv.createView({ kind: 'new', projectCwd: null });
  cv.focusView(second.id);
  const base = { hostRender: calls.hostRender, mirror: calls.mirror };
  const outside = { closest: () => null };
  for (const fn of [...(hostEl._listeners.pointerdown || [])])
    fn({ button: 0, pointerType: 'mouse', target: outside });
  for (const fn of [...(hostEl._listeners.focusin || [])]) fn({ target: outside });
  assert.equal(cv.focusedId(), second.id, 'undocked host keeps secondary focus');
  assert.equal(calls.hostRender, base.hostRender, 'no paint queued');
  assert.equal(calls.mirror, base.mirror, 'no global mirror (overview flag untouched)');
});

test('focused primary overview/title/input never mirrors or leaves overview', () => {
  const { cv, calls } = makeHarness();
  hostEl.dataset.cvwActive = '';
  hostEl._listeners = {};
  cv.bindHost();
  cv.setDocked(true, [PRIMARY_VIEW_ID]);
  assert.equal(cv.focusedId(), PRIMARY_VIEW_ID);
  const base = { hostRender: calls.hostRender, mirror: calls.mirror };
  const insideOverview = { closest: (sel) => (sel === '#project-overview' ? {} : null) };
  for (const fn of [...(hostEl._listeners.pointerdown || [])])
    fn({ button: 0, pointerType: 'mouse', target: insideOverview });
  for (const fn of [...(hostEl._listeners.focusin || [])]) fn({ target: insideOverview });
  assert.equal(cv.focusedId(), PRIMARY_VIEW_ID);
  assert.equal(calls.hostRender, base.hostRender, 'no paint queued');
  assert.equal(calls.mirror, base.mirror, 'no mirror while navigating overview');
  cv.setDocked(false, []);
});

test('docked secondary focus ignores overview-surface host gestures', () => {
  const { cv, calls } = makeHarness();
  hostEl.dataset.cvwActive = '';
  hostEl._listeners = {};
  cv.bindHost();
  cv.setDocked(true, [PRIMARY_VIEW_ID]);
  const second = cv.createView({ kind: 'new', projectCwd: null });
  cv.focusView(second.id);
  const base = { hostRender: calls.hostRender, mirror: calls.mirror };
  const insideOverview = { closest: (sel) => (sel === '#project-overview' ? {} : null) };
  for (const fn of [...(hostEl._listeners.pointerdown || [])])
    fn({ button: 0, pointerType: 'mouse', target: insideOverview });
  for (const fn of [...(hostEl._listeners.focusin || [])]) fn({ target: insideOverview });
  assert.equal(cv.focusedId(), second.id, 'secondary focus kept on overview surface');
  assert.equal(calls.hostRender, base.hostRender, 'no paint queued');
  assert.equal(calls.mirror, base.mirror, 'no mirror (overview flag untouched)');
  cv.setDocked(false, []);
});

test('docked background primary transcript still activates (deferred)', async () => {
  const { cv, calls } = makeHarness();
  hostEl.dataset.cvwActive = '';
  hostEl._listeners = {};
  cv.bindHost();
  cv.setDocked(true, [PRIMARY_VIEW_ID]);
  const second = cv.createView({ kind: 'new', projectCwd: null });
  cv.focusView(second.id);
  const base = calls.hostRender;
  const outside = { closest: () => null };
  for (const fn of [...(hostEl._listeners.pointerdown || [])])
    fn({ button: 0, pointerType: 'mouse', target: outside });
  assert.equal(cv.focusedId(), PRIMARY_VIEW_ID, 'background primary activates');
  assert.equal(calls.hostRender, base, 'paint deferred past gesture end');
  for (const fn of [...(docListeners.click || [])]) fn({});
  await tick();
  await tick();
  assert.equal(calls.hostRender, base + 1, 'paint flushes once on the next task');
  cv.setDocked(false, []);
});

test('non-primary buttons never activate (right/middle preserved)', () => {
  const { cv, calls } = makeHarness();
  const second = cv.createView({ kind: 'new', projectCwd: null });
  const shellDown = second.shell.root._listeners.pointerdown;
  const base = calls.hostRender;
  shellDown[0]({ button: 2, pointerType: 'mouse' });
  shellDown[0]({ button: 1, pointerType: 'mouse' });
  assert.equal(cv.focusedId(), PRIMARY_VIEW_ID, 'focus untouched');
  assert.equal(calls.hostRender, base, 'no paint queued');
  assert.equal(docListeners.click?.length || 0, 0, 'no flush armed');
});
