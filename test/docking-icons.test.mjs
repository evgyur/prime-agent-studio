// Dock icon regression: tabIcon (string path shapes) and lockIcon
// (rect+path object shapes) must both survive the shared glyphIcon helper.
// Pure node with a minimal document stub; no browser, no production override.
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeEl(ns, tag) {
  const el = {
    namespaceURI: ns ?? null,
    tagName: String(tag).toUpperCase(),
    attrs: {},
    dataset: {},
    children: [],
    className: '',
    setAttribute(key, value) {
      el.attrs[key] = String(value);
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
  };
  return el;
}
globalThis.document = {
  documentElement: {},
  cookie: '',
  createElement: (tag) => fakeEl(null, tag),
  createElementNS: (ns, tag) => fakeEl(ns, tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: () => {},
};
globalThis.window = { addEventListener: () => {} };
// Module top-level i18n init observes translation markers; a no-op stand-in
// keeps the import side-effect free in node.
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.NodeFilter = { SHOW_ALL: 4 };

const { tabIcon, lockIcon } = await import('../public/docking.js');

function svgOf(icon) {
  assert.equal(icon.tagName, 'SPAN');
  assert.equal(icon.attrs['aria-hidden'], 'true');
  assert.equal(icon.children.length, 1, 'icon wraps exactly one svg');
  const svg = icon.children[0];
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.attrs.viewBox, '0 0 24 24');
  assert.equal(svg.attrs.stroke, 'currentColor');
  return svg;
}

test('tabIcon renders every tab family through string path shapes', () => {
  const cases = {
    conversation: 'conversation',
    roadmap: 'roadmap',
    session: 'session',
    agents: 'agents',
    files: 'files',
    preferences: 'preferences',
    'conv:live-1': 'conversation',
    'tool:roadmap:n1': 'roadmap',
    'tool:preferences:n2': 'preferences',
  };
  for (const [id, type] of Object.entries(cases)) {
    const icon = tabIcon(id);
    assert.equal(icon.dataset.dockType, type, `${id} carries dock type ${type}`);
    const svg = svgOf(icon);
    assert.equal(svg.children.length, 1, `${id}: one path shape`);
    const [path] = svg.children;
    assert.equal(path.tagName, 'PATH');
    assert.ok(path.attrs.d && path.attrs.d.length > 8, `${id}: path has real drawing data`);
  }
});

test('lockIcon renders closed and open padlocks through object shapes', () => {
  for (const locked of [true, false]) {
    const icon = lockIcon(locked);
    const svg = svgOf(icon);
    assert.equal(svg.children.length, 2, 'lock is body rect + shackle path');
    const [rect, shackle] = svg.children;
    assert.equal(rect.tagName, 'RECT');
    assert.deepEqual(
      [rect.attrs.x, rect.attrs.y, rect.attrs.width, rect.attrs.height],
      ['5', '10.5', '14', '9.5'],
      'lock body geometry',
    );
    assert.equal(shackle.tagName, 'PATH');
    assert.ok(shackle.attrs.d.length > 8, 'shackle has real drawing data');
  }
  const closed = lockIcon(true).children[0].children[1].attrs.d;
  const open = lockIcon(false).children[0].children[1].attrs.d;
  assert.notEqual(closed, open, 'locked and unlocked shackles differ');
});
