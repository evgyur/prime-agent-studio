import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Isolated dual-instance Preferences proof: no Studio, no browser, no network.
// A minimal DOM stub backs two independent clone scopes (mimicking the parent
// clonePanelScope helper: scoped physical ids + data-panel-id). This proves:
// - every owned lookup routes through the supplied getElement (never the
//   global document for owned ids),
// - dynamically created ids/for/aria stay unique per instance,
// - global pref data is shared (computer snapshot, sync monitor) while
//   forms/view state stay independent,
// - secrets never leak between roots,
// - dispose tears down only its own instance.

// ---------- Minimal DOM stub ----------
const createdElements = [];
const documentGetElementByIdCalls = [];
const GLOBAL_DIALOG_ALLOWLIST = new Set([
  'model-config-dialog',
  'model-dialog',
  'mcp-dialog',
  'providers-dialog',
  'remote-access-dialog',
  'commands-dialog',
  'sync-forget-dialog',
]);

function makeTextNode(text) {
  return { nodeType: 3, data: String(text), parentNode: null };
}

function makeElement(tag) {
  const classes = new Set();
  const el = {
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
    tag,
    nodeType: 1,
    childNodes: [],
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    parentNode: null,
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    open: false,
    nextSibling: null,
    handlers: {},
    appendedTo: [],
    setAttribute(k, v) {
      this.attributes[String(k)] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k)
        ? this.attributes[k]
        : null;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
    append(...nodes) {
      for (const n of nodes) {
        if (n === null || n === undefined || n === false) continue;
        this.children.push(n);
        this.childNodes.push(n);
        if (typeof n === 'object') n.parentNode = this;
      }
      return this;
    },
    appendChild(n) {
      return this.append(n);
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.childNodes = [];
      return this.append(...nodes);
    },
    insertBefore(n) {
      return this.append(n);
    },
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.handlers[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    fire(type, event = {}) {
      for (const fn of [...(this.handlers[type] || [])]) fn(event);
    },
    querySelector(sel) {
      const key = String(sel);
      this.selectorCache ||= new Map();
      if (!this.selectorCache.has(key)) {
        // Resolve real descendants first (engine tier select, api content).
        const wantId = key.startsWith('#') ? key.slice(1) : null;
        let found = null;
        if (wantId) {
          const walk = (node) => {
            for (const child of node.children || []) {
              if (typeof child !== 'object') continue;
              if (child.id === wantId || child.getAttribute?.('data-panel-id') === wantId) {
                found = child;
                return true;
              }
              if (walk(child)) return true;
            }
            return false;
          };
          walk(this);
        }
        this.selectorCache.set(key, found || makeElement('div'));
      }
      return this.selectorCache.get(key);
    },
    querySelectorAll() {
      return [];
    },
    contains(node) {
      let at = node;
      while (at) {
        if (at === this) return true;
        at = at.parentNode;
      }
      return false;
    },
    closest() {
      return null;
    },
    focus() {},
    click() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.fire('close');
    },
    get firstChild() {
      return this.childNodes[0];
    },
    get isConnected() {
      return false;
    },
    scrollIntoView() {},
    reportValidity() {
      return true;
    },
    reset() {},
  };
  createdElements.push(el);
  return el;
}

const stubDocument = {
  nodeType: 9,
  hidden: false,
  activeElement: null,
  cookie: '',
  documentElement: { lang: '' },
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => makeTextNode(text),
  createDocumentFragment: () => makeElement('fragment'),
  getElementById: (id) => {
    documentGetElementByIdCalls.push(String(id));
    return null;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: () => {},
  removeEventListener: () => {},
};

globalThis.document = stubDocument;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.CSS = { escape: (value) => String(value) };
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.NodeFilter = { SHOW_ALL: 4294967295 };
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

const { createInteractionSettings } = await import('../public/interaction-settings.js');
const { createComputerPreferences, __resetSharedComputerForTests } = await import(
  '../public/computer-preferences.js'
);
const { createEngineSettings } = await import('../public/engine-settings.js');
const { createSyncSettings } = await import('../public/sync-settings.js');
const { createPublicApiSettings } = await import('../public/api-settings.js');

// Parent-like clone scope: scoped physical ids + data-panel-id logical tags.
// Mirrors parent clonePanelScope getElement fallback: template nodes first,
// then controller-created scoped ids (e.g. public-api dynamic shell).
function makeScope(prefix) {
  const nodes = new Map();
  const calls = [];
  const domId = (id) => `${prefix}:${id}`;
  const getElement = (id) => {
    calls.push(String(id));
    if (nodes.has(id)) return nodes.get(id);
    // Parent fallback is scoped-physical only (never a generic logical id from
    // another scope): match the exact domId physical id for this prefix.
    const scoped = domId(id);
    for (const el of createdElements) {
      if (el && el.id === scoped) {
        nodes.set(id, el);
        return el;
      }
    }
    const el = makeElement('scoped');
    el.setAttribute('data-panel-id', String(id));
    nodes.set(id, el);
    return el;
  };
  return { prefix, nodes, calls, getElement, domId };
}

const quietContext = () => ({ readOnly: false, remote: false, projectCwd: '/proj' });

// ---------- Interaction: scoped lookups, independent instances ----------
test('interaction instances use only their owned scope', async () => {
  documentGetElementByIdCalls.length = 0;
  const a = makeScope('A');
  const b = makeScope('B');
  let apiCalls = 0;
  const api = async (path) => {
    apiCalls++;
    assert.equal(path, '/api/studio-preferences');
    return { allowQuestionsByDefault: true };
  };
  const seen = [];
  const ia = createInteractionSettings({
    api,
    getContext: quietContext,
    onStudioPreferences: (value) => seen.push(['a', value]),
    getElement: a.getElement,
    domId: a.domId,
    instanceId: 'A',
    isPrimary: false,
  });
  const ib = createInteractionSettings({
    api,
    getContext: quietContext,
    onStudioPreferences: (value) => seen.push(['b', value]),
    getElement: b.getElement,
    domId: b.domId,
    instanceId: 'B',
    isPrimary: false,
  });
  await ia.refreshDefault();
  await ib.refreshDefault();
  assert.equal(a.getElement('default-allow-questions').checked, true);
  assert.equal(b.getElement('default-allow-questions').checked, true);
  // Owned ids never escape to the global document.
  assert.deepEqual(documentGetElementByIdCalls, []);
  assert.notEqual(a.getElement('default-allow-questions'), b.getElement('default-allow-questions'));
  assert.equal(typeof ia.dispose, 'function');
  ia.dispose();
  ib.dispose();
});

// ---------- Computer: shared confirmed data, independent view state ----------
test('computer backend/model/thinking confirm in one instance and read fresh in the other', async () => {
  documentGetElementByIdCalls.length = 0;
  const a = makeScope('A');
  const b = makeScope('B');
  const state = { computerBackend: 'native', computerModel: '', computerThinking: '' };
  const api = async (path, opts = {}) => {
    if (path === '/api/studio-preferences' && !opts.method) return { ...state };
    if (path === '/api/studio-preferences' && opts.method === 'PATCH') {
      Object.assign(state, opts.body);
      return { ...state };
    }
    if (path === '/api/computer-use')
      return {
        supported: true,
        backends: [
          { id: 'native', available: true },
          { id: 'cua', available: true },
        ],
      };
    throw new Error('unexpected ' + path);
  };
  const changed = [];
  const pa = createComputerPreferences({
    api,
    getContext: quietContext,
    getModels: () => [],
    openModelPicker: null,
    getElement: a.getElement,
    domId: a.domId,
    instanceId: 'A',
    isPrimary: true,
    onChanged: (value) => changed.push(['a', value]),
  });
  const pb = createComputerPreferences({
    api,
    getContext: quietContext,
    getModels: () => [],
    openModelPicker: null,
    getElement: b.getElement,
    domId: b.domId,
    instanceId: 'B',
    isPrimary: false,
    onChanged: (value) => changed.push(['b', value]),
  });
  pa.start();
  pb.start();
  await pa.refresh();
  await pb.refresh();
  assert.equal(pa.getBackend(), 'native');
  // Clone confirms a backend switch: primary getter reads it synchronously.
  await pb.saveBackend('cua');
  assert.equal(pb.getBackend(), 'cua');
  assert.equal(pa.getBackend(), 'cua');
  assert.equal(a.getElement('computer-backend-cua').checked, true);
  assert.deepEqual(changed, [['b', { backend: 'cua', model: '', thinking: '' }]]);
  // Model + thinking follow the same shared path.
  await pa.saveModel('m/meta-vision');
  assert.equal(pb.getModel(), 'm/meta-vision');
  await pa.saveThinking('high');
  assert.equal(pb.getThinking(), 'high');
  assert.equal(b.getElement('computer-thinking').value, 'high');
  // Owned ids never escape to the global document.
  assert.deepEqual(documentGetElementByIdCalls, []);
  pa.dispose();
  pb.dispose();
});

// ---------- Engine: unique dynamic ids, independent drafts ----------
test('engine picker ids are unique per instance and drafts stay independent', async () => {
  documentGetElementByIdCalls.length = 0;
  const settings = {
    revision: 3,
    auxiliaryModel: '',
    imageModel: '',
    providerBackupModel: '',
    nativeSubagentDefaultModel: '',
    defaultServiceTier: 'default',
    autonomous: {},
    defaults: { autonomous: { maxTurns: 10 } },
  };
  const api = async () => JSON.parse(JSON.stringify(settings));
  const models = [{ id: 'm/meta-vision', name: 'Vision', provider: 'm' }];
  const pickerTargets = [];
  const openModelPicker = (target) => {
    pickerTargets.push(target);
    target.onSelect('m/meta-vision');
  };
  const mk = (scope, primary) =>
    createEngineSettings({
      api,
      getContext: quietContext,
      getModels: () => models,
      openModelPicker,
      icon: null,
      onChanged: () => {},
      getElement: scope.getElement,
      domId: scope.domId,
      instanceId: scope.prefix,
      isPrimary: primary,
    });
  const a = makeScope('A');
  const b = makeScope('B');
  const ea = mk(a, true);
  const eb = mk(b, false);
  assert.ok(ea.root);
  await ea.open();
  await eb.open();
  const createdIds = createdElements.map((el) => el.id).filter(Boolean);
  assert.ok(createdIds.includes('A:engine-auxiliaryModel'));
  assert.ok(createdIds.includes('B:engine-auxiliaryModel'));
  assert.ok(!createdIds.includes('engine-auxiliaryModel'));
  // Label htmlFor tracks the scoped physical id.
  const auxLabel = createdElements.find((el) => el.htmlFor === 'A:engine-auxiliaryModel');
  assert.ok(auxLabel);
  // Draft in A only: open the picker on A and pick; B keeps the engine default.
  const before = pickerTargets.length;
  const entryA = createdElements.find((el) => el.id === 'A:engine-auxiliaryModel');
  entryA.onclick();
  assert.equal(pickerTargets.length, before + 1);
  assert.equal(entryA.value, 'm/meta-vision');
  const entryB = createdElements.find((el) => el.id === 'B:engine-auxiliaryModel');
  assert.equal(entryB.value, '');
  // Global singletons only (model dialogs); owned ids never escape.
  for (const id of documentGetElementByIdCalls) assert.ok(GLOBAL_DIALOG_ALLOWLIST.has(id), id);
  ea.dispose();
  eb.dispose();
});

// ---------- Sync: shared server data, owned focus, cleared secrets ----------
test('sync shares server state across instances without leaking drafts or focus', async () => {
  documentGetElementByIdCalls.length = 0;
  let server = { configured: false, url: '', accessKeyId: '', device: 'pc-a' };
  const api = async (path, opts = {}) => {
    if (path === '/api/overview') return { projects: [] };
    if (path === '/api/sync' && !opts.method) return JSON.parse(JSON.stringify(server));
    if (path === '/api/sync' && opts.method === 'PUT') {
      server = { ...server, configured: true, url: opts.body.url, accessKeyId: opts.body.accessKeyId };
      return JSON.parse(JSON.stringify(server));
    }
    throw new Error('unexpected ' + path);
  };
  const a = makeScope('A');
  const b = makeScope('B');
  const sa = createSyncSettings({
    api,
    getContext: quietContext,
    toast: () => {},
    getElement: a.getElement,
    domId: a.domId,
    instanceId: 'A',
    isPrimary: true,
  });
  const sb = createSyncSettings({
    api,
    getContext: quietContext,
    toast: () => {},
    getElement: b.getElement,
    domId: b.domId,
    instanceId: 'B',
    isPrimary: false,
  });
  await sa.refresh();
  await sb.refresh();
  // A configures sync: B reflects the shared state, secrets stay write-only.
  a.getElement('sync-url').value = 'https://s3.example';
  a.getElement('sync-access-key').value = 'AKID';
  a.getElement('sync-secret').value = 'SUPER-SECRET-A';
  a.getElement('sync-device').value = 'pc-a';
  const formA = a.getElement('sync-form');
  await formA.onsubmit({ preventDefault: () => {} });
  // flush the shared-monitor microtask fan-out
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(b.getElement('sync-url').value, 'https://s3.example');
  assert.equal(a.getElement('sync-secret').value, '');
  assert.equal(b.getElement('sync-secret').value, '');
  // Typing guard is per-root: A typing keeps its draft while B re-renders.
  // Real DOM parents inputs inside their own form; wire that parentage so the
  // stub's form.contains(activeElement) ownership check behaves faithfully.
  a.getElement('sync-form').append(a.getElement('sync-url'));
  b.getElement('sync-form').append(b.getElement('sync-url'));
  b.getElement('sync-url').value = 'https://s3.example';
  a.getElement('sync-url').value = 'https://typing.local';
  stubDocument.activeElement = a.getElement('sync-url');
  stubDocument.activeElement.id = a.domId('sync-url');
  await sa.refresh();
  assert.equal(a.getElement('sync-url').value, 'https://typing.local');
  stubDocument.activeElement = null;
  for (const id of documentGetElementByIdCalls) assert.ok(GLOBAL_DIALOG_ALLOWLIST.has(id), id);
  sa.dispose();
  sb.dispose();
});

// ---------- Public API: unique shell ids, per-root secrets ----------
test('public api shells stay unique and token secrets never cross roots', async () => {
  documentGetElementByIdCalls.length = 0;
  const dialogOf = (scope) => {
    const dialog = scope.getElement('settings-dialog');
    dialog.querySelector = (sel) => {
      dialog.selectorCache ||= new Map();
      if (!dialog.selectorCache.has(sel)) dialog.selectorCache.set(sel, makeElement('container'));
      return dialog.selectorCache.get(sel);
    };
    return dialog;
  };
  const mkApi = (scope, primary) => {
    dialogOf(scope);
    return { scope, ui: null, primary };
  };
  const a = mkApi(makeScope('A'), true);
  const b = mkApi(makeScope('B'), false);
  const apiState = {
    revision: 1,
    enabled: true,
    tokens: [],
    projects: [{ id: 'p_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Proj', cwd: '/p' }],
    machineId: 'm1',
    endpoints: [],
  };
  const api = async (path, opts = {}) => {
    if (path === '/api/public-api' && !opts.method) return JSON.parse(JSON.stringify(apiState));
    if (path === '/api/public-api/tokens' && opts.method === 'POST') {
      apiState.tokens = [
        { id: 't1', name: opts.body.name, scopes: opts.body.scopes, projectIds: opts.body.projectIds },
      ];
      apiState.revision += 1;
      return { state: JSON.parse(JSON.stringify(apiState)), credential: 'SECRET-TOKEN-A' };
    }
    throw new Error('unexpected ' + path + ' ' + (opts.method || 'GET'));
  };
  const copyTexts = [];
  a.ui = createPublicApiSettings({
    api,
    getContext: quietContext,
    copyText: (value) => copyTexts.push(['a', value]),
    toast: () => {},
    icon: null,
    getElement: a.scope.getElement,
    domId: a.scope.domId,
    instanceId: 'A',
    isPrimary: true,
  });
  b.ui = createPublicApiSettings({
    api,
    getContext: quietContext,
    copyText: (value) => copyTexts.push(['b', value]),
    toast: () => {},
    icon: null,
    getElement: b.scope.getElement,
    domId: b.scope.domId,
    instanceId: 'B',
    isPrimary: false,
  });
  await a.ui.refresh();
  await b.ui.refresh();
  // Shell ids are unique per instance, tagged with the logical id.
  const nameA = a.scope.getElement('public-api-name');
  const nameB = b.scope.getElement('public-api-name');
  assert.notEqual(nameA, nameB);
  assert.equal(nameA.id, 'A:public-api-name');
  assert.equal(nameB.id, 'B:public-api-name');
  assert.equal(nameA.getAttribute('data-panel-id'), 'public-api-name');
  const tabA = a.scope.getElement('settings-tab-api');
  const tabB = b.scope.getElement('settings-tab-api');
  assert.ok(tabA && tabB && tabA !== tabB);
  // A creates a token: the secret shows only in A.
  nameA.value = 'ci-token';
  a.scope.getElement('public-api-all-projects').checked = true;
  const formA = a.scope.getElement('public-api-create-form');
  await formA.onsubmit({ preventDefault: () => {} });
  assert.equal(a.scope.getElement('public-api-secret').hidden, false);
  assert.equal(a.scope.getElement('public-api-credential').textContent, 'SECRET-TOKEN-A');
  assert.equal(b.scope.getElement('public-api-secret').hidden, true);
  assert.equal(b.scope.getElement('public-api-credential').textContent, '');
  // Closing A's dialog clears A's secret only; B untouched.
  a.scope.getElement('settings-dialog').fire('close');
  assert.equal(a.scope.getElement('public-api-credential').textContent, '');
  assert.equal(b.scope.getElement('public-api-secret').hidden, true);
  for (const id of documentGetElementByIdCalls) assert.ok(GLOBAL_DIALOG_ALLOWLIST.has(id), id);
  a.ui.dispose();
  b.ui.dispose();
});

// ---------- Static contract guards (settings.js + desktop-updates.js) ----------
test('primary-only global registrations and scoped plumbing are present in source', async () => {
  const { readFile } = await import('node:fs/promises');
  const settings = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  const updates = await readFile(new URL('../public/desktop-updates.js', import.meta.url), 'utf8');
  const computer = await readFile(new URL('../public/computer-preferences.js', import.meta.url), 'utf8');
  // Scoped integration API on the main factory.
  assert.match(
    settings,
    /export function createSettings\(\{\s*api,\s*getContext,\s*openResources,[\s\S]*?getElement[\s\S]*?domId[\s\S]*?instanceId[\s\S]*?isPrimary/,
  );
  for (const file of [settings, updates, computer])
    assert.ok(file.includes('root') && file.includes('dispose'), 'root/dispose exposed');
  // Exactly one global quit path / components opener / boot intent.
  assert.match(updates, /if \(primary\) \{\s*window\.addEventListener\('studio:quit-request'/);
  assert.match(settings, /if \(primary\) registerDesktopComponentsOpener/);
  assert.match(settings, /if \(primary && new URLSearchParams\(location\.search\)/);
  // Owned visibility + unique dynamic ids.
  assert.ok(updates.includes('ownedDialog()?.open'));
  assert.ok(settings.includes("scopedId('settings-qr-dialog')"));
  assert.ok(settings.includes("globalById(id)?.addEventListener('close', handler)"));
  assert.ok(settings.includes("globalById(id)?.removeEventListener('close', handler)"));
  // Cross-instance confirmed-value sync path for sendMessage freshness.
  assert.ok(computer.includes('publishComputer({ backend }'));
  assert.ok(computer.includes('onChanged({ backend, model, thinking })'));
  assert.ok(computer.includes('sharedComputer?.backend'));
  // Per-instance stale guards.
  assert.ok(settings.includes('generation++'));
  assert.ok(updates.includes('localEpoch++'));
});

// ---------- Computer: late GET never rolls back a newer confirmed PATCH ----------
test('delayed GET, other-instance PATCH, late GET keeps the newer confirmed values', async () => {
  __resetSharedComputerForTests?.();
  documentGetElementByIdCalls.length = 0;
  const a = makeScope('A');
  const b = makeScope('B');
  // Server with real revisions: GET rev 10 (native), PATCH bumps to rev 11 (cua).
  let server = {
    computerBackend: 'native',
    computerModel: '',
    computerThinking: '',
    revision: 10,
  };
  let releaseFirstGet = null;
  let firstGetStarted = false;
  const api = async (path, opts = {}) => {
    if (path === '/api/computer-use')
      return {
        supported: true,
        backends: [
          { id: 'native', available: true },
          { id: 'cua', available: true },
        ],
      };
    if (path === '/api/studio-preferences' && !opts.method) {
      if (!firstGetStarted) {
        firstGetStarted = true;
        // First GET from A hangs: snapshot rev 10 now, resolve it stale after
        // B confirms rev 11.
        const stale = { ...server };
        await new Promise((resolve) => {
          releaseFirstGet = resolve;
        });
        return stale;
      }
      return { ...server };
    }
    if (path === '/api/studio-preferences' && opts.method === 'PATCH') {
      if ('computerBackend' in opts.body) server.computerBackend = opts.body.computerBackend;
      if ('computerModel' in opts.body) server.computerModel = opts.body.computerModel;
      if ('computerThinking' in opts.body) server.computerThinking = opts.body.computerThinking;
      server.revision += 1;
      return { ...server };
    }
    throw new Error('unexpected ' + path);
  };
  const pa = createComputerPreferences({
    api,
    getContext: quietContext,
    getModels: () => [],
    openModelPicker: null,
    getElement: a.getElement,
    domId: a.domId,
    instanceId: 'A',
    isPrimary: true,
    onChanged: () => {},
  });
  const pb = createComputerPreferences({
    api,
    getContext: quietContext,
    getModels: () => [],
    openModelPicker: null,
    getElement: b.getElement,
    domId: b.domId,
    instanceId: 'B',
    isPrimary: false,
    onChanged: () => {},
  });
  pa.start();
  pb.start();
  const pendingA = pa.refresh();
  // Let A's GET start and block inside api().
  await new Promise((resolve) => setTimeout(resolve, 0));
  // B refreshes cleanly at rev 10, then confirms cua at rev 11.
  await pb.refresh();
  assert.equal(pb.getBackend(), 'native');
  await pb.saveBackend('cua');
  assert.equal(pb.getBackend(), 'cua');
  assert.equal(pa.getBackend(), 'cua');
  // Now release A's stale GET (rev 10 snapshot): it must not roll back.
  releaseFirstGet();
  await pendingA;
  assert.equal(server.revision, 11);
  assert.equal(pa.getBackend(), 'cua');
  assert.equal(pb.getBackend(), 'cua');
  assert.deepEqual(documentGetElementByIdCalls, []);
  pa.dispose();
  pb.dispose();
  __resetSharedComputerForTests?.();
});

// ---------- Settings trackChild contract (dynamic resourceOnly child) ----------
test('settings exposes trackChild and passes the opener to openResources', async () => {
  const { readFile } = await import('node:fs/promises');
  const settings = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  // Public integration API the parent calls before entry.resources.open(source).
  assert.ok(settings.includes('function trackChild(childDialog, opener)'));
  assert.ok(settings.includes('trackChild,'));
  // Opener travels as the 2nd openResources arg from the owned button.
  assert.ok(settings.includes('void openResources(source, opener)'));
  assert.ok(settings.includes('const opener = event?.currentTarget || $(id)'));
  // Yield guard covers dynamic children; dispose removes only its own listener.
  assert.ok(settings.includes('trackedChildren'));
  assert.ok(settings.includes('[...trackedChildren.keys()].some((node) => node?.open)'));
  assert.ok(settings.includes("node?.removeEventListener?.('close', entry?.handler)"));
});

// ---------- allowQuestions: delayed GET, sibling PATCH, late GET keeps newer value ----------
test('delayed allowQuestions GET, sibling PATCH, late GET keeps the newer confirmed value', async () => {
  const fresh = await import('../public/interaction-settings.js?allowq-rev=1');
  documentGetElementByIdCalls.length = 0;
  let server = { allowQuestionsByDefault: true, revision: 10 };
  let releaseFirstGet = null;
  let firstGetStarted = false;
  const api = async (path, opts = {}) => {
    if (path === '/api/studio-preferences' && !opts.method) {
      if (!firstGetStarted) {
        firstGetStarted = true;
        const stale = { ...server };
        await new Promise((resolve) => {
          releaseFirstGet = resolve;
        });
        return stale;
      }
      return { ...server };
    }
    if (path === '/api/studio-preferences' && opts.method === 'PATCH') {
      server = {
        allowQuestionsByDefault: !!opts.body.allowQuestionsByDefault,
        revision: server.revision + 1,
      };
      return { ...server };
    }
    throw new Error('unexpected ' + path);
  };
  const seenA = [];
  const seenB = [];
  const mk = (scope, seen) =>
    fresh.createInteractionSettings({
      api,
      getContext: quietContext,
      onStudioPreferences: (value) => seen.push(value),
      getElement: scope.getElement,
      domId: scope.domId,
      instanceId: scope.prefix,
      isPrimary: false,
    });
  const a = makeScope('A');
  const b = makeScope('B');
  const ia = mk(a, seenA);
  const ib = mk(b, seenB);
  const pendingA = ia.refreshDefault();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ib.refreshDefault();
  assert.equal(seenB.length, 1);
  assert.equal(seenB[0].allowQuestionsByDefault, true);
  // B confirms false at rev 11; A is still blocked inside its rev-10 GET.
  b.getElement('default-allow-questions').checked = false;
  await b.getElement('default-allow-questions').onchange();
  assert.equal(seenB[seenB.length - 1].allowQuestionsByDefault, false);
  assert.equal(seenB[seenB.length - 1].revision, 11);
  releaseFirstGet();
  await pendingA;
  assert.equal(server.revision, 11);
  assert.equal(a.getElement('default-allow-questions').checked, false);
  assert.equal(b.getElement('default-allow-questions').checked, false);
  assert.equal(seenA.length, 0);
  assert.deepEqual(documentGetElementByIdCalls, []);
  ia.dispose();
  ib.dispose();
});

// ---------- allowQuestions: stale PATCH ack never rolls back a newer value ----------
test('stale allowQuestions PATCH ack never rolls back a newer confirmed value', async () => {
  const fresh = await import('../public/interaction-settings.js?allowq-ack=1');
  documentGetElementByIdCalls.length = 0;
  let server = { allowQuestionsByDefault: false, revision: 20 };
  let releaseA = null;
  let patchCount = 0;
  const api = async (path, opts = {}) => {
    if (path === '/api/studio-preferences' && !opts.method) return { ...server };
    if (path === '/api/studio-preferences' && opts.method === 'PATCH') {
      patchCount++;
      const assigned = {
        allowQuestionsByDefault: !!opts.body.allowQuestionsByDefault,
        revision: server.revision + 1,
      };
      server = assigned;
      if (patchCount === 1) {
        await new Promise((resolve) => {
          releaseA = resolve;
        });
      }
      return { ...assigned };
    }
    throw new Error('unexpected ' + path);
  };
  const seenA = [];
  const seenB = [];
  const mk = (scope, seen) =>
    fresh.createInteractionSettings({
      api,
      getContext: quietContext,
      onStudioPreferences: (value) => seen.push(value),
      getElement: scope.getElement,
      domId: scope.domId,
      instanceId: scope.prefix,
      isPrimary: false,
    });
  const a = makeScope('A');
  const b = makeScope('B');
  const ia = mk(a, seenA);
  const ib = mk(b, seenB);
  await ia.refreshDefault();
  await ib.refreshDefault();
  // A starts a slow PATCH to true (assigned rev 21); B confirms false fast
  // (assigned rev 22) while A is still in flight.
  a.getElement('default-allow-questions').checked = true;
  const pendingAck = a.getElement('default-allow-questions').onchange();
  await new Promise((resolve) => setTimeout(resolve, 0));
  b.getElement('default-allow-questions').checked = false;
  await b.getElement('default-allow-questions').onchange();
  assert.equal(b.getElement('default-allow-questions').checked, false);
  releaseA();
  await pendingAck;
  assert.equal(server.revision, 22);
  assert.equal(a.getElement('default-allow-questions').checked, false);
  assert.equal(b.getElement('default-allow-questions').checked, false);
  assert.ok(seenA.every((value) => value.allowQuestionsByDefault === false));
  assert.deepEqual(documentGetElementByIdCalls, []);
  ia.dispose();
  ib.dispose();
});

// ---------- Sync monitor startup: disallowed first init, live re-init fetches once ----------
test('sync monitor retries the missing initial snapshot on live re-init without extra pollers', async () => {
  // Fresh module instance: clean shared monitor state, isolated from the
  // panels above (same DOM stub, own timers).
  const fresh = await import('../public/sync-settings.js?startup-monitor=1');
  let gets = 0;
  const api = async (path) => {
    if (path === '/api/sync') {
      gets++;
      return { configured: false };
    }
    throw new Error('unexpected ' + path);
  };
  // First init pre-bootstrap (readOnly): the fetch is skipped, no GET.
  fresh.initSyncMonitor({ api, getContext: () => ({ readOnly: true, remote: false }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gets, 0);
  // Live context replaces it: immediate one GET, not a 30s wait.
  fresh.initSyncMonitor({ api, getContext: () => ({ readOnly: false, remote: false }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gets, 1);
  // Later clones with a snapshot only reschedule: no extra GET, one poller.
  fresh.initSyncMonitor({ api, getContext: () => ({ readOnly: false, remote: false }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gets, 1);
  fresh.__stopSyncMonitorForTests();
});

// Fixture housekeeping (not a functional test): stop the app-lifetime shared
// sync poller after the suite so the normal runner exits on a drained loop.
after(async () => {
  const { __stopSyncMonitorForTests } = await import('../public/sync-settings.js');
  __stopSyncMonitorForTests();
});
