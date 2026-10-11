import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { closePanel, groupsOf, isConversationPanel, validateLayout } from '../public/docking-layout.js';

const source = await readFile(new URL('../public/docking.js', import.meta.url), 'utf8');

// --- Slice 1: tab context menu must offer the short "Fermer" entry. ---
const menuStart = source.indexOf('  function openContextMenu(');
const menuEnd = source.indexOf('  for (const popup of [menu, addMenu])', menuStart);
assert.ok(menuStart >= 0 && menuEnd > menuStart, 'Production tab menu must exist');
const menuSlice = source.slice(menuStart, menuEnd);

test('tab menu close entry is the short label, without the panel name', () => {
  assert.match(menuSlice, /tr\('ui\.fermer'\)/, 'menu close uses the short Fermer/Close label');
  assert.doesNotMatch(menuSlice, /tr\('docking\.close'/, 'menu close never interpolates the panel name');
  assert.match(
    menuSlice,
    /finish\(\(\) => removePanel\(id\)\)/,
    'menu close reuses the shared removePanel path',
  );
});

// --- Slice 2: chrome close button keeps its descriptive accessible label. ---
test('chrome close button keeps its descriptive accessible label', () => {
  assert.match(
    source,
    /bindAttribute\(close, 'aria-label', \(\) => tr\('docking\.close', \{ panel: label\(model\.active\) \}\)\)/,
    'bar close button stays descriptive (Fermer {panel})',
  );
});

// --- Slice 3: middle-click wiring on tabs. ---
const buildStart = source.indexOf('    for (const id of model.panels) {');
const buildEnd = source.indexOf('    bar.append(tabs);', buildStart);
assert.ok(buildStart >= 0 && buildEnd > buildStart, 'Production tab builder must exist');
const buildSlice = source.slice(buildStart, buildEnd);

test('middle-click closes the tab through the shared path, without autoscroll or activation', () => {
  const auxAt = buildSlice.indexOf('onauxclick');
  assert.ok(auxAt >= 0, 'tabs wire onauxclick');
  const auxSlice = buildSlice.slice(auxAt, auxAt + 400);
  assert.match(auxSlice, /button !== 1/, 'only the middle button closes');
  assert.match(auxSlice, /preventDefault\(\)/, 'middle-click prevents autoscroll');
  assert.match(auxSlice, /removePanel\(id\)/, 'middle-click reuses the shared removePanel path');
  assert.doesNotMatch(auxSlice, /activatePanel|openPanel/, 'middle-click never activates the closed panel');
  const downAt = buildSlice.indexOf('onmousedown');
  assert.ok(downAt >= 0, 'tabs guard mousedown for autoscroll');
  const downSlice = buildSlice.slice(downAt, downAt + 200);
  assert.match(downSlice, /button === 1/, 'mousedown guard targets the middle button only');
  assert.match(downSlice, /preventDefault\(\)/, 'mousedown guard blocks middle autoscroll');
  assert.doesNotMatch(downSlice, /removePanel/, 'mousedown never closes (close happens on auxclick)');
  assert.doesNotMatch(buildSlice.slice(auxAt, auxAt + 400), /dragged\s*=/, 'middle-click starts no drag');
});

// --- Slice 4: shared removePanel path actually closes and falls back. ---
const rmStart = source.indexOf('  function removePanel(');
const rmEnd = source.indexOf('  function updateViewport()', rmStart);
assert.ok(rmStart >= 0 && rmEnd > rmStart, 'Production removePanel must exist');
const rmHandler = source.slice(rmStart, rmEnd);

const layout = validateLayout({
  version: 3,
  root: {
    kind: 'split',
    id: 'root',
    dir: 'row',
    ratio: 0.6,
    first: {
      kind: 'group',
      id: 'left',
      panels: ['conversation', 'conv:b', 'roadmap'],
      active: 'conversation',
    },
    second: { kind: 'group', id: 'right', panels: ['conv:c', 'session', 'files'], active: 'conv:c' },
  },
});
assert.ok(layout);

function invokeRemove(id, current = layout, active = true) {
  const commits = [];
  const removePanel = runInNewContext(`(${rmHandler})`, {
    active,
    layout: current,
    closePanel,
    groupsOf,
    isConversationPanel,
    commit: (next, focus) => commits.push({ next, focus }),
    opener: { focus: () => commits.push({ openerFocus: true }) },
  });
  removePanel(id);
  return commits;
}

test('shared path closes the middle-clicked inactive tab with one commit and keeps the other group', () => {
  const before = JSON.stringify(layout);
  const commits = invokeRemove('conv:b');
  assert.equal(commits.length, 1);
  assert.notEqual(commits[0].focus, 'conv:b', 'focus never lands on the closed tab');
  const left = groupsOf(commits[0].next).find((group) => group.id === 'left');
  assert.deepEqual(left.panels, ['conversation', 'roadmap']);
  assert.deepEqual(commits[0].next.root.second, layout.root.second, 'other group stays intact');
  assert.equal(JSON.stringify(layout), before, 'source layout is immutable');
});

test('shared path ignores close requests while the workspace is inactive', () => {
  assert.deepEqual(invokeRemove('conv:b', layout, false), []);
});
