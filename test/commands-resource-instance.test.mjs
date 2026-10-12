// Commands resourceOnly pickers (targeted, no browser, no model, no Studio).
// Standalone project-bound resource pickers for locked Preferences: dialog-only
// public UI, own cwd/session per caller context, onInsert before any mutation,
// global composer never touched. Ordinary primary/conv paths are untouched here
// (covered by scripts/test-commands-ui.mjs + test/command* suites in browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// --- Minimal DOM stub (dialog/catalog/folder/insert/destroy only) ---
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this.value = '';
    this.type = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.textContent = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.parentNode = null;
    this.parentElement = null;
    this.isConnected = true;
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this.events = [];
  }
  get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }
  append(...nodes) {
    for (const n of nodes.flat()) {
      if (n == null || n === false) continue;
      if (typeof n === 'string') continue;
      n.parentNode = this;
      n.parentElement = this;
      this.children.push(n);
    }
    return this;
  }
  appendChild(n) { return this.append(n); }
  replaceChildren(...nodes) {
    for (const c of this.children) {
      if (c && typeof c === 'object') { c.parentNode = null; c.parentElement = null; }
    }
    this.children = [];
    if (nodes.length) this.append(...nodes);
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  contains() { return false; }
  closest() { return null; }
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; }
  getClientRects() { return []; }
  focus() {}
  scrollIntoView() {}
  setRangeText() { this.events.push('setRangeText'); }
  setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
  dispatchEvent() { this.events.push('dispatch'); return true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {
    if (this.parentNode?.children) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    }
    this.parentNode = null;
    this.parentElement = null;
    this.isConnected = false;
  }
}

const byId = new Map();
const body = new FakeElement('body');
const head = new FakeElement('head');
const fakeLocalStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
// Global composer stands in for the live `#composer`: resource inserts must
// never read or write it.
const composer = new FakeElement('textarea');
composer.id = 'composer';
composer.value = 'hello active draft';
byId.set('composer', composer);
const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, data: String(text), parentNode: null }),
  getElementById: (id) => byId.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  head,
  body,
  activeElement: null,
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => null,
};
const fakeWindow = { innerWidth: 1600, innerHeight: 1000, addEventListener() {}, removeEventListener() {} };

// localStorage must exist before import (i18n reads it at module top), but
// document/window must NOT (i18n would init real DOM observers otherwise).
globalThis.localStorage = fakeLocalStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { createCommands } = await import('../public/commands.js');

globalThis.document = fakeDocument;
globalThis.window = fakeWindow;
globalThis.innerWidth = 1600;
globalThis.innerHeight = 1000;

const source = await readFile(new URL('../public/commands.js', import.meta.url), 'utf8');

function findAll(el, pred, out = []) {
  if (pred(el)) out.push(el);
  for (const c of el?.children || []) findAll(c, pred, out);
  return out;
}
// NOTE: node() binds an i18n text anchor as children[0], so container children
// are addressed by tag/class, never by position.
const childButtons = (el) => (el.children || []).filter((c) => c.tagName === 'BUTTON');
const CATALOG = {
  commands: [
    { name: 'alpha', source: 'skill', supported: true, description: 'Alpha skill', sourceInfo: { scope: 'project', path: '/p/alpha' } },
    { name: 'beta', source: 'prompt', supported: true, description: 'Beta prompt' },
    { name: 'old-tool', source: 'terminal', supported: false, reason: 'No terminal here' },
  ],
  live: true,
};
function makePicker(ctx, { onInsert } = {}) {
  const calls = [];
  const api = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url === '/api/commands/open-directory') return { opened: true };
    if (url.startsWith('/api/commands?')) return structuredClone(CATALOG);
    throw new Error(`unexpected api call: ${url}`);
  };
  const holder = { doc: null };
  const view = createCommands({
    api,
    getContext: () => ctx,
    onInsert,
    resourceOnly: true,
  });
  return { view, calls, holder };
}
async function openAndLoad(picker) {
  picker.view.open();
  for (let i = 0; i < 400; i++) {
    const rows = findAll(
      picker.view.dialog,
      (el) => el.tagName === 'BUTTON' && String(el.className).includes('command-item') && !el.disabled,
    );
    if (rows.length >= 2) return rows;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('catalog rows never rendered');
}

test('three resource pickers: dialog-only UI, distinct ids, no primary ids', () => {
  const a = makePicker({ cwd: '/projA', sessionId: 'sess-A', readOnly: false, online: true });
  const b = makePicker({ cwd: '/projB', sessionId: 'sess-B', readOnly: false, online: true });
  const c = makePicker({ cwd: '/projC', sessionId: 'sess-C', readOnly: false, online: true });
  try {
    for (const p of [a, b, c]) {
      assert.ok(p.view.dialog, 'dialog exposed for settings tracking');
      assert.equal(typeof p.view.open, 'function');
      assert.equal(typeof p.view.update, 'function');
      assert.equal(typeof p.view.destroy, 'function');
      assert.notEqual(p.view.dialog.id, 'commands-dialog', 'never the primary id');
      assert.match(p.view.dialog.id, /^cmd\d+-dialog$/, `scoped id: ${p.view.dialog.id}`);
    }
    const ids = [a.view.dialog.id, b.view.dialog.id, c.view.dialog.id];
    assert.equal(new Set(ids).size, 3, `dialog ids distinct: ${ids}`);
    assert.ok(body.children.includes(a.view.dialog));
    assert.ok(body.children.includes(b.view.dialog));
    assert.ok(body.children.includes(c.view.dialog));
    // Dialog-only: no suggestion popups, no launcher buttons mounted anywhere.
    assert.equal(findAll(body, (el) => String(el.className).includes('command-suggestions')).length, 0);
    assert.equal(findAll(body, (el) => el.id === 'open-commands').length, 0);
    assert.equal(findAll(body, (el) => el.id === 'command-folder-scope').length, 0);
    assert.equal(findAll(body, (el) => el.id === 'command-open-folder').length, 0);
  } finally {
    b.view.destroy();
    assert.ok(body.children.includes(a.view.dialog), 'sibling survives destroy');
    assert.ok(!body.children.includes(b.view.dialog), 'destroyed dialog removed');
    a.view.destroy();
    c.view.destroy();
  }
});

test('catalog GET and folder POST use the caller own cwd/session', async () => {
  const a = makePicker({ cwd: '/projA', sessionId: 'sess-A', readOnly: false, online: true });
  const c = makePicker({ cwd: '/projC', sessionId: 'sess-C', readOnly: false, online: true });
  try {
    await openAndLoad(a);
    await openAndLoad(c);
    const getA = a.calls.find((call) => call.url.startsWith('/api/commands?'));
    const getC = c.calls.find((call) => call.url.startsWith('/api/commands?'));
    assert.ok(getA.url.includes(`cwd=${encodeURIComponent('/projA')}`), getA.url);
    assert.ok(getA.url.includes(`sessionId=${encodeURIComponent('sess-A')}`), getA.url);
    assert.ok(getC.url.includes(`cwd=${encodeURIComponent('/projC')}`), getC.url);
    assert.ok(getC.url.includes(`sessionId=${encodeURIComponent('sess-C')}`), getC.url);
    // Folder action on C targets C only: filter skill + project scope.
    const filters = findAll(c.view.dialog, (el) => String(el.className).includes('command-filters'));
    assert.equal(filters.length, 1);
    const filterBtns = childButtons(filters[0]).filter((b) => !String(b.className).includes('command-refresh'));
    assert.equal(filterBtns.length, 4);
    filterBtns[1].onclick(); // skill filter
    const folders = findAll(c.view.dialog, (el) => String(el.className).includes('command-folders'));
    const folderScope = folders[0].children.find((c) => c.tagName === 'SELECT');
    const openFolder = childButtons(folders[0])[0];
    assert.equal(typeof openFolder.onclick, 'function');
    folderScope.value = 'project';
    await openFolder.onclick();
    const post = c.calls.find((call) => call.url === '/api/commands/open-directory');
    assert.deepEqual(post.body, { cwd: '/projC', source: 'skill', scope: 'project' });
    assert.ok(!a.calls.some((call) => call.url === '/api/commands/open-directory'), 'A never posted');
  } finally {
    a.view.destroy();
    c.view.destroy();
  }
});

test('insert calls onInsert first, closes own dialog, never touches global composer', async () => {
  const picked = [];
  const a = makePicker(
    { cwd: '/projA', sessionId: 'sess-A', readOnly: false, online: true },
    { onInsert: (command) => picked.push(command.name) },
  );
  const b = makePicker(
    { cwd: '/projB', sessionId: 'sess-B', readOnly: false, online: true },
    { onInsert: () => false }, // keep dialog open
  );
  try {
    const rowsA = await openAndLoad(a);
    assert.ok(a.view.dialog.open, 'dialog open before pick');
    rowsA[0].onclick();
    assert.deepEqual(picked, ['alpha'], 'caller got the explicit pick');
    assert.equal(a.view.dialog.open, false, 'own dialog closed by default');
    assert.equal(composer.value, 'hello active draft', 'global composer text kept');
    assert.deepEqual(composer.events, [], 'no global composer mutation events');

    const rowsB = await openAndLoad(b);
    rowsB[0].onclick();
    assert.equal(b.view.dialog.open, true, 'false verdict keeps dialog open');
    assert.equal(composer.value, 'hello active draft');
    assert.deepEqual(composer.events, []);
  } finally {
    a.view.destroy();
    b.view.destroy();
  }
});

test('unsupported commands stay disabled behind the standard guards', async () => {
  const a = makePicker({ cwd: '/projA', sessionId: 'sess-A', readOnly: false, online: true });
  try {
    await openAndLoad(a);
    const filters = findAll(a.view.dialog, (el) => String(el.className).includes('command-filters'));
    const filterBtns = childButtons(filters[0]).filter((b) => !String(b.className).includes('command-refresh'));
    filterBtns[3].onclick(); // terminal filter
    const rows = findAll(a.view.dialog, (el) => el.tagName === 'BUTTON' && String(el.className).includes('command-item'));
    assert.ok(rows.length >= 1, 'terminal row rendered');
    assert.ok(rows.every((row) => row.disabled), 'unsupported rows disabled');
    assert.match(source, /if \(!command\.supported \|\| input\.disabled/, 'guard order in source');
  } finally {
    a.view.destroy();
  }
});

test('resource core never binds global composer, chips, or inline prefetch', () => {
  assert.match(source, /resourceOnly = false/, 'opt-in flag with legacy default');
  assert.match(source, /resourceOnly \? \(\) => detachedInput\.value/, 'local text getter');
  assert.match(source, /const chip = resourceOnly \? null/, 'no chip in resource mode');
  assert.match(source, /const button = resourceOnly \? null/, 'no launcher in resource mode');
  assert.match(source, /const popup = resourceOnly \? null/, 'no popup in resource mode');
  assert.match(source, /if \(!resourceOnly\) \{\s*\n\s*input\.addEventListener/, 'no input listeners');
  assert.match(source, /!resourceOnly && context\.cwd/, 'no prefetch');
  assert.match(source, /dialog,/, 'dialog exposed on the returned controller');
});
