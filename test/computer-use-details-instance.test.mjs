import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputerUse } from '../public/computer-use.js';
import { t as tr } from '../public/i18n.js';

function element() {
  const attributes = new Map();
  return {
    nodeType: 1,
    childNodes: [],
    dataset: {},
    hidden: false,
    classList: { toggle() {} },
    get firstChild() {
      return this.childNodes[0];
    },
    get textContent() {
      return this.childNodes.map((node) => node.data).join('');
    },
    replaceChildren(...nodes) {
      this.childNodes = nodes;
      for (const node of nodes) node.parentNode = this;
    },
    setAttribute(key, value) {
      attributes.set(key, String(value));
    },
    getAttribute(key) {
      return attributes.get(key) ?? null;
    },
  };
}
const detailIds = [
  'computer-use-details',
  'computer-use-warning',
  'computer-use-owner',
  'computer-use-action',
  'computer-use-hotkey',
];
const scope = (ids) => {
  const nodes = new Map(ids.map((id) => [id, element()]));
  return (id) => nodes.get(id) || null;
};

test('one Computer Use controller paints independent Session details without rerouting controls', async (t) => {
  const main = scope(['computer-use', 'allow-computer-use', 'computer-use-toggle', 'computer-use-status']);
  const a = scope(detailIds),
    b = scope(detailIds);
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    getElementById: main,
    createTextNode: (data) => ({ nodeType: 3, data, parentNode: null }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const globalContext = { projectCwd: '/B', sessionId: 'sess-b', online: true, readOnly: false };
  const contextA = { projectCwd: '/A', sessionId: 'sess-a', online: true, readOnly: false };
  const contextB = { ...globalContext };
  const requests = [];
  const status = {
    supported: true,
    enabled: false,
    owner: { sessionId: 'sess-a', name: 'Alpha' },
    lastAction: 'Fixture action',
    hotkey: 'Esc',
  };
  const ui = createComputerUse({
    api: async (path, options) => {
      requests.push({ path, method: options?.method || 'GET' });
      return status;
    },
    toast: () => assert.fail('No action or error toast expected'),
    getContext: () => globalContext,
    getDetailTargets: () => [
      { getElement: a, getContext: () => contextA },
      { getElement: b, getContext: () => contextB },
    ],
  });
  t.after(() => ui.destroy());
  await ui.refresh();
  assert.equal(requests.length, 1);
  assert.equal(a('computer-use-details').hidden, false);
  assert.equal(b('computer-use-details').hidden, false);
  assert.equal(a('computer-use-owner').textContent, tr('computer.ownerMine'));
  assert.equal(b('computer-use-owner').textContent, 'Alpha');
  assert.equal(a('computer-use-action').textContent, 'Fixture action');
  assert.equal(b('computer-use-hotkey').textContent, 'Esc');
  assert.equal(main('allow-computer-use').checked, false, 'Toolbar still belongs to focused B');
  globalContext.projectOverview = true;
  ui.update();
  assert.equal(main('computer-use').hidden, true);
  assert.equal(
    a('computer-use-details').hidden,
    false,
    'Pinned A stays visible over another project overview',
  );
  status.owner = { sessionId: 'sess-b', name: 'Beta' };
  await ui.refresh();
  assert.equal(a('computer-use-owner').textContent, 'Beta');
  assert.equal(b('computer-use-owner').textContent, tr('computer.ownerMine'));
  contextA.unavailable = true;
  ui.update();
  assert.equal(a('computer-use-details').hidden, true);
  globalContext.readOnly = true;
  assert.equal(await ui.setEnabled(true), false);
  assert.ok(
    requests.every((request) => request.method === 'GET'),
    'Detail targets never create native actions or writes',
  );
});

test('visible pinned details keep exactly one existing status poller alive', async (t) => {
  const main = scope(['computer-use']);
  const a = scope(detailIds);
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    getElementById: main,
    createTextNode: (data) => ({ nodeType: 3, data, parentNode: null }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  let tick,
    calls = 0,
    visible = true;
  const intervals = t.mock.method(globalThis, 'setInterval', (callback) => {
    tick = callback;
    return 42;
  });
  const clears = t.mock.method(globalThis, 'clearInterval', () => {});
  const ui = createComputerUse({
    api: async () => {
      calls++;
      return { supported: true };
    },
    toast() {},
    getContext: () => ({ projectCwd: '/B', projectOverview: true, online: true }),
    getDetailTargets: () =>
      visible ? [{ getElement: a, getContext: () => ({ projectCwd: '/A', sessionId: 'a' }) }] : [],
  });
  ui.start();
  ui.start();
  await Promise.resolve();
  assert.equal(intervals.mock.callCount(), 1);
  assert.equal(calls, 1);
  tick();
  await Promise.resolve();
  assert.equal(calls, 2, 'Visible pin refreshes shared status while focused toolbar is hidden');
  visible = false;
  tick();
  await Promise.resolve();
  assert.equal(calls, 2, 'No visible desktop surface means no background requests');
  ui.destroy();
  assert.equal(clears.mock.callCount(), 1);
});
