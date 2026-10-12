import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectorFetchPlan, inspectorUnitAria, INSPECTOR_UNIT_IDS, inspectorUnitVisible } from '../public/inspector.js';

// Visible-datasets-only matrix (preserved M2/fetchplan assertions).
test('inspector fetch plan stays visible-datasets-only', () => {
  assert.deepEqual([...INSPECTOR_UNIT_IDS], ['session', 'agents', 'files']);
  assert.deepEqual(inspectorFetchPlan({ session: true }), { agents: true, files: false, git: false, quota: true, any: true });
  assert.deepEqual(inspectorFetchPlan({ agents: true }), { agents: true, files: false, git: false, quota: false, any: true });
  assert.deepEqual(inspectorFetchPlan({ files: true }), { agents: true, files: true, git: true, quota: false, any: true });
  assert.deepEqual(inspectorFetchPlan({}), { agents: false, files: false, git: false, quota: false, any: false });
  assert.deepEqual(inspectorFetchPlan({ session: true, agents: true, files: true }), { agents: true, files: true, git: true, quota: true, any: true });
});

test('unit visibility enforces geometry, hidden and dock membership', () => {
  // Disconnected/hidden never poll, even when selected or dock-listed.
  assert.equal(inspectorUnitVisible({ connected: false, hidden: false, rects: 1, classicSelected: true }), false);
  assert.equal(inspectorUnitVisible({ connected: true, hidden: true, rects: 1, classicSelected: true }), false);
  assert.equal(inspectorUnitVisible({ connected: true, hidden: true, rects: 1, docked: true, dockMember: true }), false);
  // Classic: selected + nonempty rects only.
  assert.equal(inspectorUnitVisible({ connected: true, hidden: false, rects: 1, classicSelected: true }), true);
  assert.equal(inspectorUnitVisible({ connected: true, hidden: false, rects: 1, classicSelected: false }), false);
  assert.equal(inspectorUnitVisible({ connected: true, hidden: false, rects: 0, classicSelected: true }), false);
  // Docked: membership + nonempty rects; parked (member but zero rects) stays quiet.
  assert.equal(inspectorUnitVisible({ connected: true, hidden: false, rects: 2, docked: true, dockMember: true }), true);
  assert.equal(inspectorUnitVisible({ connected: true, hidden: false, rects: 2, docked: true, dockMember: false }), false);
  assert.equal(inspectorUnitVisible({ connected: true, hidden: false, rects: 0, docked: true, dockMember: true }), false);
});

test('inspector unit aria stays classic vs docked', () => {
  assert.deepEqual(inspectorUnitAria('session', false), { role: 'tabpanel', labelledby: 'inspector-tab-session' });
  assert.deepEqual(inspectorUnitAria('agents', true), { role: null, labelledby: null });
  assert.equal(inspectorUnitAria('unknown', false), null);
});

const source = await readFile(new URL('../public/inspector.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/inspector.css', import.meta.url), 'utf8');
const sub = await readFile(new URL('../public/subagent-settings.js', import.meta.url), 'utf8');

test('createInspector accepts scoped multi-instance options', () => {
  assert.match(source, /getElement,\s*\n?\s*domId,\s*\n?\s*unit,\s*\n?\s*instanceId/);
  assert.match(source, /const isSingle = isInspectorUnit\(unit\)/);
  assert.match(source, /resolveUnitContext\(getContext, key\)/);
  assert.match(source, /primaryUnitDomId\(key\)/);
  assert.match(source, /createMappedPrimaryFacade/);
});

test('primary facade owns mobile shell and tab gating exactly once', () => {
  assert.match(source, /syncFacadeMobile/);
  assert.match(source, /onFacadePanelKey/);
  assert.match(source, /aria-modal/);
  assert.match(source, /syncFacadeTabs/);
  assert.match(source, /facadeTimer/);
  assert.doesNotMatch(source, /bindUnit\(\)/);
});

test('single units never touch sibling units or global panel', () => {
  assert.match(source, /if \(isSingle && key !== unit\) return false;/);
  assert.match(source, /if \(!owns\('session'\)\) return;/);
  assert.match(source, /if \(!owns\('agents'\)\) return;/);
  assert.match(source, /if \(!owns\('files'\)\) return;/);
  assert.match(source, /!isSingle \|\| unit === 'agents'/);
  assert.doesNotMatch(source, /document\.querySelectorAll\('#inspector-file-list/);
  assert.match(source, /scopeList\.querySelectorAll\('\.git-file-check'\)/);
});

test('dynamic IDs go through domId for unique clones', () => {
  for (const id of ['inspector-viewer', 'git-branch-dialog', 'git-branch-name', 'inspector-quota', 'inspector-context', 'inspector-view-body']) {
    assert.ok(source.includes(`mapId('${id}')`), id);
  }
  assert.match(source, /viewer\.dataset\.inspectorInstance/);
  assert.match(source, /viewer\.remove\(\)/);
  assert.match(source, /opener\?\.focus/);
});

test('git and file writes keep originating cwd and refuse readOnly', () => {
  assert.match(source, /!owns\('files'\) \|\| !current\.cwd \|\| current\.readOnly \|\| gitAction/);
  assert.match(source, /body: \{ cwd, \.\.\.body \}/);
  assert.match(source, /const cwd = current\.cwd,\s*\n?\s*token = generation;/);
  assert.match(source, /filesUrlFor\(docCwd, 'resolve'/);
  assert.match(source, /openFile\([\s\S]*?result\.path[\s\S]*?'preview',[\s\S]*?docCwd/);
});

test('quota dispatch stays session-gated', () => {
  assert.match(source, /if \(!current\.enabled \|\| !current\.online \|\| document\.hidden \|\| !unitVisible\('session'\)\) return;/);
});

test('primary inner ids derive from mapped logical id, not instance', () => {
  assert.match(source, /prefix: mapId\('project-subagent'\)/);
  assert.doesNotMatch(source, /\$\{instance\}-project-subagent/);
});

test('subagent id selectors escape colon instance prefixes', () => {
  assert.match(sub, /escapeCssId/);
  assert.match(sub, /CSS\.escape/);
  assert.match(sub, /byId\(`\$\{prefix\}-model`\)/);
  assert.match(sub, /byId\(`\$\{prefix\}-thinking`\)/);
  assert.match(sub, /byId\(`\$\{prefix\}-model-label`\)/);
  assert.doesNotMatch(sub, /\$\(`#\$\{prefix\}/);
});

test('subagent settings stay project-scoped with per-instance cleanup', () => {
  assert.match(sub, /prefixOverride/);
  assert.match(sub, /destroy\(\)/);
  assert.match(sub, /removeEventListener\('subagent-defaults-changed'/);
});

test('css supports scoped data-panel-id aliases', () => {
  for (const id of ['inspector-session', 'inspector-quota', 'inspector-context', 'inspector-agent-count', 'open-project-folder', 'close-inspector']) {
    assert.ok(css.includes(`[data-panel-id='${id}']`), id);
  }
});
