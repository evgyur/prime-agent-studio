import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Focused scope tests for the Preferences auxiliary UI split:
// public/push.js, public/passkeys.js (per-clone scoped forms) and
// public/mcp.js, public/providers.js, public/remote-access.js (singleton
// global managers with explicit open(opener?)).
// Isolated fake-DOM fixtures only. No real notifications, WebAuthn, account
// mutation, Studio, models, build or browser suite.

// ---------------------------------------------------------------------------
// Minimal fake DOM (just enough for the five modules + real i18n bindings).
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag = 'div', doc = null) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this._doc = doc;
    this.children = [];
    this.childNodes = this.children;
    this.dataset = {};
    this._attrs = {};
    this._listeners = {};
    this.parentNode = null;
    this._id = '';
    this._class = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.type = '';
    this.title = '';
    this.open = false;
    this._modal = false;
    this.isConnected = true;
    this.scrollTop = 0;
    this._visible = false;
    this.focused = false;
  }
  get id() {
    return this._id;
  }
  set id(v) {
    this._id = String(v);
    if (this._doc && v) this._doc._byId.set(String(v), this);
  }
  get className() {
    return this._class;
  }
  set className(v) {
    this._class = String(v);
  }
  get firstChild() {
    return this.children[0];
  }
  getAttribute(name) {
    return this._attrs[name] ?? null;
  }
  setAttribute(name, value) {
    this._attrs[name] = String(value);
    if (name === 'id') this.id = String(value);
  }
  removeAttribute(name) {
    delete this._attrs[name];
  }
  append(...nodes) {
    for (const n of nodes) {
      if (!n) continue;
      n.parentNode = this;
      this.children.push(n);
      this._doc?.registerTree(n);
    }
    return this;
  }
  appendChild(n) {
    return this.append(n);
  }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.childNodes = this.children;
    if (nodes.length) this.append(...nodes);
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (list) this._listeners[type] = list.filter((f) => f !== fn);
  }
  emit(type, event = {}) {
    for (const fn of [...(this._listeners[type] || [])]) fn(event);
  }
  matches(selector) {
    if (selector === ':modal') return this.open && this._modal;
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    let node = this;
    while (node) {
      try {
        if (node.matches(selector)) return node;
      } catch {}
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (selector.startsWith('#')) {
          if (child.id === selector.slice(1)) out.push(child);
        } else if (selector.startsWith('.')) {
          if (String(child.className || '').split(/\s+/).includes(selector.slice(1))) out.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  getClientRects() {
    return this._visible ? [{}] : [];
  }
  focus(_opts) {
    this.focused = true;
    if (this._doc) this._doc.focused = this;
  }
  showModal() {
    this.open = true;
    this._modal = true;
  }
  show() {
    this.open = true;
    this._modal = false;
  }
  close(_ret) {
    this.open = false;
    this._modal = false;
    this.emit('close', {});
    try {
      this.onclose?.();
    } catch {}
  }
  reset() {}
  reportValidity() {
    return true;
  }
  set innerHTML(html) {
    this.replaceChildren();
    // Flat parse: one owned node per tag carrying its id/class. Enough for
    // manager dialogs whose lookups are id- or single-class-based.
    for (const tag of String(html).matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
      const el = new FakeElement(tag[1], this._doc);
      const attrs = tag[2];
      const id = attrs.match(/\bid\s*=\s*"([^"]+)"/)?.[1];
      const cls = attrs.match(/\bclass\s*=\s*"([^"]+)"/)?.[1];
      if (cls) el.className = cls;
      if (id) el.id = id;
      this.append(el);
    }
  }
  get innerHTML() {
    return '';
  }
}

function makeDocument() {
  const doc = {
    nodeType: 9,
    _byId: new Map(),
    _listeners: {},
    focused: null,
    hidden: false,
    body: null,
    getElementById(id) {
      return doc._byId.get(id) || null;
    },
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text) {
      return { nodeType: 3, data: String(text), parentNode: null };
    },
    addEventListener(type, fn) {
      (doc._listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      doc._listeners[type] = (doc._listeners[type] || []).filter((f) => f !== fn);
    },
    listenerCount(type) {
      return (doc._listeners[type] || []).length;
    },
    querySelectorAll() {
      return [];
    },
    contains(node) {
      return !!node && node.isConnected !== false;
    },
    registerTree(node) {
      if (!node) return;
      if (node.id) doc._byId.set(node.id, node);
      for (const child of node.children || []) doc.registerTree(child);
    },
  };
  doc.body = new FakeElement('body', doc);
  doc.documentElement = new FakeElement('html', doc);
  doc.documentElement.lang = '';
  doc.cookie = '';
  doc.querySelector = () => null;
  doc.createTreeWalker = () => ({ nextNode: () => null });
  return doc;
}

class FakeObserver {
  constructor(fn) {
    this.fn = fn;
    this.targets = [];
    FakeObserver.live.add(this);
  }
  observe(target, opts) {
    this.targets.push({ target, opts });
  }
  disconnect() {
    this.targets = [];
    FakeObserver.live.delete(this);
  }
}
FakeObserver.live = new Set();

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] || null,
    get length() {
      return map.size;
    },
  };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await wait(20);
  }
  assert.fail('condition timed out');
}

// ---------------------------------------------------------------------------
// Global fixture install (document/window/navigator before module import).
// ---------------------------------------------------------------------------

const doc = makeDocument();
const windowListeners = {};
const fetchCalls = [];
const fetchRoutes = new Map();
const historyCalls = [];

globalThis.document = doc;
globalThis.window = {
  get isSecureContext() {
    return true;
  },
  __PRIME_STUDIO_DESKTOP__: undefined,
  PushManager: {},
  addEventListener(type, fn) {
    (windowListeners[type] ||= []).push(fn);
  },
  removeEventListener(type, fn) {
    windowListeners[type] = (windowListeners[type] || []).filter((f) => f !== fn);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};
globalThis.MutationObserver = FakeObserver;
globalThis.NodeFilter = { SHOW_ALL: 0 };
globalThis.Option = function Option(text = '', value = '') {
  const el = new FakeElement('option', doc);
  el.textContent = text;
  el.value = value;
  return el;
};
globalThis.localStorage = makeStorage();
globalThis.location = { protocol: 'https:', search: '', pathname: '/' };
globalThis.history = {
  replaceState: (...args) => void historyCalls.push(args),
};
globalThis.confirm = () => false;
globalThis.fetch = async (path, opts = {}) => {
  fetchCalls.push({ path: String(path), opts });
  const route = fetchRoutes.get(String(path).split('?')[0]);
  const body = typeof route === 'function' ? await route(String(path), opts) : (route ?? {});
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(body)),
  };
};

const swMessages = [];
const fakeSubscription = {
  endpoint: 'https://push.example/e1',
  toJSON: () => ({ endpoint: 'https://push.example/e1', keys: { p256dh: 'x', auth: 'y' } }),
  unsubscribe: async () => true,
};
let swSubscription = fakeSubscription;
Object.defineProperty(globalThis, 'navigator', {
  value: {
    serviceWorker: {
    ready: Promise.resolve({
      pushManager: {
        getSubscription: () => Promise.resolve(swSubscription),
        subscribe: async () => swSubscription,
      },
    }),
    addEventListener: (type, fn) => void swMessages.push({ type, fn }),
    },
  },
  configurable: true,
  writable: true,
});
globalThis.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
globalThis.PublicKeyCredential = function () {};

const push = await import('../public/push.js');
const passkeys = await import('../public/passkeys.js');

// ---------------------------------------------------------------------------
// Push fixtures: primary ids in document, clone ids in an owned map.
// ---------------------------------------------------------------------------

const PUSH_IDS = [
  'push-options',
  'push-unsupported',
  'push-enable',
  'push-questions',
  'push-turn-complete',
  'push-error',
  'settings-dialog',
];

function makePushNodes(suffix = '') {
  const map = new Map();
  for (const id of PUSH_IDS) {
    const el = new FakeElement(id === 'settings-dialog' ? 'dialog' : 'div', doc);
    if (suffix) {
      el.id = `panel-P${suffix}--${id}`;
      el.dataset.panelId = id;
    } else {
      el.id = id;
    }
    map.set(id, el);
  }
  return map;
}

function installPrimaryPush() {
  return makePushNodes('');
}

test('push: clone scopes every lookup to its owned root, primary defaults unchanged', async (t) => {
  const primaryNodes = installPrimaryPush();
  const cloneNodes = makePushNodes('clone1');
  fetchRoutes.set('/api/push/subscriptions', { questions: false, turnComplete: true });
  const primary = push.createPushSettings({});
  const clone = push.createPushSettings({
    getElement: (id) => cloneNodes.get(id) || doc.getElementById(`panel-Pclone1--${id}`),
    domId: (id) => `panel-Pclone1--${id}`,
    instanceId: 'tool:preferences:clone1',
    isPrimary: false,
  });
  t.after(() => {
    primary.dispose();
    clone.dispose();
  });
  await primary.refresh();
  await until(() => cloneNodes.get('push-enable').checked === true);
  // Shared confirmed prefs reached the clone form without its own refresh.
  assert.equal(cloneNodes.get('push-questions').checked, false);
  assert.equal(cloneNodes.get('push-turn-complete').checked, true);
  // Primary rendered into the real document ids, clone never touched them.
  assert.equal(primaryNodes.get('push-questions').checked, false);
  assert.equal(doc.getElementById('push-enable').checked, true);
  assert.ok(primary.root === doc.getElementById('settings-dialog'));
  assert.ok(clone.root === cloneNodes.get('settings-dialog'));
});

test('push: clone registers no browser listeners and deep-link stays primary-only', async (t) => {
  installPrimaryPush();
  const cloneNodes = makePushNodes('clone2');
  const docBefore = doc.listenerCount('visibilitychange');
  const winBefore = (windowListeners.pagehide || []).length;
  const swBefore = swMessages.length;
  const primary = push.createPushSettings({});
  const clone = push.createPushSettings({
    getElement: (id) => cloneNodes.get(id),
    domId: (id) => `panel-Pclone2--${id}`,
    instanceId: 'tool:preferences:clone2',
    isPrimary: false,
  });
  t.after(() => {
    primary.dispose();
    clone.dispose();
  });
  assert.equal(doc.listenerCount('visibilitychange'), docBefore + 1);
  assert.equal((windowListeners.pagehide || []).length, winBefore + 1);
  primary.listenMessages(() => {});
  assert.equal(swMessages.length, swBefore + 1);
  // Clone registrations are no-ops.
  clone.listenMessages(() => {});
  assert.equal(swMessages.length, swBefore + 1);
  assert.equal(doc.listenerCount('visibilitychange'), docBefore + 1);
  assert.equal(await clone.consumeDeepLink(() => assert.fail('clone must not select')), false);
  assert.deepEqual(historyCalls.length, 0);
  // Primary deep link with no params resolves false without selecting.
  assert.equal(await primary.consumeDeepLink(() => assert.fail('no session must not select')), false);
  // Dispose removes the primary registrations; clone dispose is a safe no-op.
  const docMid = doc.listenerCount('visibilitychange');
  clone.dispose();
  assert.equal(doc.listenerCount('visibilitychange'), docMid);
  primary.dispose();
  assert.equal(doc.listenerCount('visibilitychange'), docBefore);
});

test('push: dispose stops the beat and gates stale refreshes', async (t) => {
  installPrimaryPush();
  fetchRoutes.set('/api/push/subscriptions', { questions: true, turnComplete: true });
  const ui = push.createPushSettings({});
  t.after(() => ui.dispose());
  await ui.refresh();
  ui.dispose();
  // A refresh racing dispose resolves silently without touching the form.
  const box = doc.getElementById('push-enable');
  box.checked = 'sentinel';
  await ui.refresh();
  assert.equal(box.checked, 'sentinel');
});

// ---------------------------------------------------------------------------
// Passkey fixtures.
// ---------------------------------------------------------------------------

const PASSKEY_IDS = [
  'passkey-dialog',
  'passkey-form',
  'passkey-add',
  'passkey-cancel',
  'passkey-error',
  'passkey-fields',
  'passkey-title',
  'passkey-note',
  'passkey-submit',
  'passkey-name',
  'passkey-code',
  'passkey-list',
  'passkey-status',
  'passkey-hint',
  'settings-panel-remote',
  'settings-dialog',
];

function makePasskeyNodes(suffix = '') {
  const map = new Map();
  for (const id of PASSKEY_IDS) {
    const tag = id.endsWith('-dialog') || id === 'settings-dialog' ? 'dialog' : id.endsWith('-form') ? 'form' : 'div';
    const el = new FakeElement(tag, doc);
    if (suffix) {
      el.id = `panel-P${suffix}--${id}`;
      el.dataset.panelId = id;
    } else {
      el.id = id;
    }
    map.set(id, el);
  }
  return map;
}

function passkeyScope(map, suffix) {
  return {
    getElement: (id) => map.get(id) || doc.getElementById(`panel-P${suffix}--${id}`),
    domId: (id) => `panel-P${suffix}--${id}`,
  };
}

test('passkey: clone renders into its owned dialog/panel, never the primary', async (t) => {
  // Inert primary decoys: no instance owns them, so any write there is a leak.
  const primaryNodes = makePasskeyNodes('');
  const cloneNodes = makePasskeyNodes('pk1');
  let listCalls = 0;
  fetchRoutes.set('/api/passkeys', () => {
    listCalls++;
    return { keys: [{ id: 'k1', name: 'owner-key' }] };
  });
  const getContext = () => ({ remote: false, readOnly: false });
  const already = new Set(FakeObserver.live);
  const clone = passkeys.createPasskeySettings({
    getContext,
    ...passkeyScope(cloneNodes, 'pk1'),
    instanceId: 'tool:preferences:pk1',
    isPrimary: false,
  });
  t.after(() => clone.dispose());
  await clone.refresh();
  assert.equal(listCalls, 1);
  assert.equal(cloneNodes.get('passkey-list').children.length, 1);
  assert.equal(primaryNodes.get('passkey-list').children.length, 0);
  assert.ok(clone.root === cloneNodes.get('settings-dialog'));
  // The clone observes only its owned panel/dialog, never the primary nodes.
  const fresh = [...FakeObserver.live].filter((o) => !already.has(o));
  assert.equal(fresh.length, 2);
  const observed = fresh.flatMap((o) => o.targets.map((e) => e.target));
  assert.ok(observed.includes(cloneNodes.get('settings-panel-remote')));
  assert.ok(observed.includes(cloneNodes.get('settings-dialog')));
  assert.ok(!observed.includes(primaryNodes.get('settings-panel-remote')));
  assert.ok(!observed.includes(primaryNodes.get('settings-dialog')));
});

test('passkey: confirmed revoke in one clone refreshes the other owner form', async (t) => {
  const nodesA = makePasskeyNodes('pkA');
  const nodesB = makePasskeyNodes('pkB');
  let keys = [{ id: 'k1', name: 'owner-key' }];
  let listCalls = 0;
  const revoked = [];
  fetchRoutes.set('/api/passkeys', () => {
    listCalls++;
    return { keys };
  });
  fetchRoutes.set('/api/passkeys/revoke', (_path, opts) => {
    revoked.push(JSON.parse(opts.body));
    keys = [];
    return {};
  });
  const getContext = () => ({ remote: false, readOnly: false });
  const a = passkeys.createPasskeySettings({
    getContext,
    ...passkeyScope(nodesA, 'pkA'),
    instanceId: 'tool:preferences:pkA',
    isPrimary: false,
  });
  const b = passkeys.createPasskeySettings({
    getContext,
    ...passkeyScope(nodesB, 'pkB'),
    instanceId: 'tool:preferences:pkB',
    isPrimary: false,
  });
  t.after(() => {
    a.dispose();
    b.dispose();
  });
  await a.refresh();
  await b.refresh();
  assert.equal(nodesA.get('passkey-list').children.length, 1);
  const before = listCalls;
  // Revoke through A's owned modal via the row revoke button (no WebAuthn there).
  const row = nodesA.get('passkey-list').children[0];
  assert.ok(row);
  const revokeButton = row.children.find((child) => child.tagName === 'BUTTON');
  assert.ok(revokeButton);
  revokeButton.onclick();
  assert.equal(nodesA.get('passkey-dialog').open, true);
  assert.equal(nodesB.get('passkey-dialog').open, false);
  await nodesA.get('passkey-form').onsubmit({ preventDefault: () => {} });
  assert.deepEqual(revoked.length, 1);
  // B re-fetched via fan-out and cleared its list; the secret never lingers.
  await until(() => listCalls > before + 1);
  await until(() => nodesB.get('passkey-list').children.length === 0);
  assert.equal(nodesA.get('passkey-code').value, '');
});

test('passkey: dispose disconnects observers and gates stale requests', async (t) => {
  const nodes = makePasskeyNodes('pkD');
  fetchRoutes.set('/api/passkeys', async () => {
    await wait(30);
    return { keys: [] };
  });
  const already = new Set(FakeObserver.live);
  const ui = passkeys.createPasskeySettings({
    getContext: () => ({ remote: false, readOnly: false }),
    ...passkeyScope(nodes, 'pkD'),
    instanceId: 'tool:preferences:pkD',
    isPrimary: false,
  });
  const mine = [...FakeObserver.live].filter((o) => !already.has(o));
  assert.equal(mine.length, 2);
  const pending = ui.refresh();
  ui.dispose();
  await pending;
  for (const observer of mine) assert.ok(!FakeObserver.live.has(observer));
  assert.equal(nodes.get('passkey-code').value, '');
});

// ---------------------------------------------------------------------------
// Singleton manager contracts: explicit open(opener?) + primary wiring.
// ---------------------------------------------------------------------------

test('manager contracts expose open(opener?) and keep the primary opener wired', async () => {
  const root = new URL('../public/', import.meta.url);
  const mcp = await readFile(new URL('mcp.js', root), 'utf8');
  const providers = await readFile(new URL('providers.js', root), 'utf8');
  const remote = await readFile(new URL('remote-access.js', root), 'utf8');
  for (const [name, source] of [
    ['mcp', mcp],
    ['providers', providers],
    ['remote', remote],
  ]) {
    assert.match(source, /function open\(opener\)/, `${name} exposes open(opener?)`);
    assert.match(source, /return \{ open \}/, `${name} returns { open }`);
    assert.match(
      source,
      /currentTarget \|\| .*target/,
      `${name} normalizes an Event opener to its button`,
    );
  }
  // MCP/remote release ONLY the owning Preferences modal from the opener and
  // never the global primary. Providers stacks above the owner (it never
  // closes settings, even on the primary path), so it keeps no modal lookup.
  for (const [name, source] of [
    ['mcp', mcp],
    ['remote', remote],
  ]) {
    assert.match(
      source,
      /closest\?\.\(\s*['"]\.settings-modal['"]\s*\)/,
      `${name} resolves the owning Preferences modal from the opener`,
    );
  }
  assert.doesNotMatch(providers, /settings-dialog/, 'providers never touches settings');
  assert.match(
    mcp,
    /open\(event\?\.currentTarget \|\| event\?\.target\)/,
    'mcp primary opener calls the same open()',
  );
  assert.match(
    providers,
    /open\(event\?\.currentTarget \|\| event\?\.target\)/,
    'providers primary opener calls the same open()',
  );
  assert.match(
    remote,
    /open\(event\?\.currentTarget \|\| event\?\.target\)/,
    'remote primary opener calls the same open()',
  );
  // No clone of the remote manager, no project fallback in any manager.
  assert.doesNotMatch(remote, /clonePanelScope|domId\(|getElement\(/);
  assert.doesNotMatch(mcp + providers + remote, /projectCwd \?\?|fallbackProject|activeProject/);
});

test('mcp manager opens from a clone button, releases only its owner, and spares primary focus', async (t) => {
  const mcp = await import('../public/mcp.js');
  // Primary nodes.
  const primarySettings = new FakeElement('dialog', doc);
  primarySettings.id = 'settings-dialog';
  primarySettings.className = 'modal settings-modal';
  const primaryBtn = new FakeElement('button', doc);
  primaryBtn.id = 'open-mcp-settings';
  const headerBtn = new FakeElement('button', doc);
  headerBtn.id = 'open-settings';
  headerBtn._visible = true;
  doc.body.append(primarySettings, primaryBtn, headerBtn);
  // Clone owner modal + scoped button (parent-supplied, same instance prefix).
  const cloneSettings = new FakeElement('dialog', doc);
  cloneSettings.id = 'panel-Pm1--settings-dialog';
  cloneSettings.dataset.panelId = 'settings-dialog';
  cloneSettings.className = 'modal settings-modal';
  const cloneBtn = new FakeElement('button', doc);
  cloneBtn.id = 'panel-Pm1--open-mcp-settings';
  cloneBtn.dataset.panelId = 'open-mcp-settings';
  cloneSettings.append(cloneBtn);
  doc.body.append(cloneSettings);
  fetchRoutes.set('/api/mcp', { servers: [] });
  const manager = mcp.createMcpSettings({ api: (p, o) => globalThis.fetch(p, o).then((r) => r.json()), toast: () => {} });
  t.after(() => {
    for (const el of [primarySettings, primaryBtn, headerBtn, cloneSettings]) el.remove();
    doc._byId.delete('mcp-dialog');
  });
  assert.equal(typeof manager.open, 'function');
  // Clone launch: only the owning modal is released, primary stays open.
  primarySettings.showModal();
  cloneSettings.showModal();
  await manager.open(cloneBtn);
  assert.equal(cloneSettings.open, false);
  assert.equal(primarySettings.open, true);
  assert.equal(doc.getElementById('mcp-dialog').open, true);
  // Closing after a clone launch never force-focuses the hidden primary header.
  doc.focused = null;
  headerBtn.focused = false;
  doc.getElementById('mcp-dialog').close();
  assert.equal(headerBtn.focused, false);
  // Primary path still releases the primary modal and restores its focus.
  primarySettings.showModal();
  const event = { preventDefault: () => {}, currentTarget: primaryBtn, target: primaryBtn };
  await manager.open(event);
  assert.equal(primarySettings.open, false);
  doc.getElementById('mcp-dialog').close();
  assert.equal(headerBtn.focused, true);
});

test('providers manager honors the global gate and opens from a clone button', async (t) => {
  const providers = await import('../public/providers.js');
  const primaryBtn = new FakeElement('button', doc);
  primaryBtn.id = 'open-provider-settings';
  doc.body.append(primaryBtn);
  fetchRoutes.set('/api/providers', { providers: [], warning: '', busy: false });
  let changed = 0;
  const manager = providers.createProviderSettings({
    api: (p, o) => globalThis.fetch(p, o).then((r) => r.json()),
    toast: () => {},
    allowed: () => true,
    onChanged: async () => void changed++,
  });
  t.after(() => {
    primaryBtn.remove();
    doc._byId.delete('providers-dialog');
  });
  assert.equal(typeof manager.open, 'function');
  const cloneBtn = new FakeElement('button', doc);
  manager.open(cloneBtn);
  await until(() => doc.getElementById('providers-dialog').open === true);
  assert.equal(changed, 0);
  doc.getElementById('providers-dialog').close();
  // Read-only gate unchanged: denied openers never show the dialog.
  const gated = providers.createProviderSettings({
    api: (p, o) => globalThis.fetch(p, o).then((r) => r.json()),
    toast: () => {},
    allowed: () => false,
    onChanged: async () => {},
  });
  gated.open(primaryBtn);
  await wait(30);
  assert.equal(doc.getElementById('providers-dialog').open, false);
});

test('remote manager releases only the owning modal and keeps the read-only gate', async (t) => {
  // Remote dialog lives in the real page; mirror its ids in the fixture doc.
  for (const id of [
    'remote-access-dialog',
    'remote-code-form',
    'remote-code-error',
    'remote-code-fields',
    'remote-code',
    'remote-code-confirmation',
    'remote-access-status',
    'show-remote-code',
    'save-remote-code',
    'open-remote-access',
  ]) {
    if (!doc.getElementById(id)) {
      const tag = id === 'remote-access-dialog' ? 'dialog' : id === 'remote-code-form' ? 'form' : 'div';
      const el = new FakeElement(tag, doc);
      el.id = id;
      doc.body.append(el);
    }
  }
  const remote = await import('../public/remote-access.js');
  const primarySettings = doc.getElementById('settings-dialog') || new FakeElement('dialog', doc);
  if (!primarySettings.id) {
    primarySettings.id = 'settings-dialog';
    primarySettings.className = 'modal settings-modal';
  }
  const cloneSettings = new FakeElement('dialog', doc);
  cloneSettings.id = 'panel-Pr1--settings-dialog';
  cloneSettings.className = 'modal settings-modal';
  const cloneBtn = new FakeElement('button', doc);
  cloneBtn.id = 'panel-Pr1--open-remote-access';
  cloneSettings.append(cloneBtn);
  doc.body.append(cloneSettings);
  fetchRoutes.set('/api/remote-access', { revision: 'r1', configured: true });
  let remoteFlag = false;
  const manager = remote.createRemoteAccessSettings({
    api: (p, o) => globalThis.fetch(p, o).then((r) => r.json()),
    isRemote: () => remoteFlag,
    toast: () => {},
  });
  t.after(() => cloneSettings.remove());
  assert.equal(typeof manager.open, 'function');
  primarySettings.showModal();
  cloneSettings.showModal();
  await manager.open(cloneBtn);
  assert.equal(cloneSettings.open, false);
  assert.equal(primarySettings.open, true);
  assert.equal(doc.getElementById('remote-access-dialog').open, true);
  doc.getElementById('remote-access-dialog').close();
  // Read-only gate unchanged: remote viewers never load the code form.
  remoteFlag = true;
  fetchCalls.length = 0;
  await manager.open(cloneBtn);
  assert.ok(!fetchCalls.some((c) => c.path === '/api/remote-access'));
});
