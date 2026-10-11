// Isolated tab-close UI test: short "Fermer" menu entry + real middle-click close.
//
// SCOPE: this file ONLY creates scripts/test-docking-tab-close-ui.mjs plus its
// OWN runtime artifacts under .local/conversation-loading-tabs/ (captures +
// proof JSON). No other Studio source is edited by this test, and no existing
// test file or M2 assertion is touched.
// NEVER: production server, real provider account, real model, user Lab 62542,
// installed Studio, install/build/commit/publish. Seeding uses the real
// createApp fixture API plus normal UI input and a real middle mouse button
// (page.mouse down/up with button 'middle'). Captures are genuine screenshots
// only: this test never forces hidden/classes/DOM state for visuals (reading
// refs/scroll/storage through page.evaluate for comparison is allowed and is
// NOT UI forcing).

import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const DOCK = {
  openButton: '#open-docking',
  dialog: '#docking-settings',
  toggle: '#docking-toggle',
  closeSettings: '#docking-close-settings',
  workspace: '#dock-workspace',
  tab: 'button[data-dock-tab]',
  ellipsis: '.dock-bar > .dock-chrome-button:not([data-dock-close])',
  contextMenu: '#docking-context-menu',
  addMenu: '#docking-add-menu',
};

const OUT_ROOT = resolve('.local/conversation-loading-tabs/captures');
const PROOF_PATH = resolve('.local/conversation-loading-tabs/tab-close-ui-proof.json');

const temp = await mkdtemp(join(tmpdir(), 'prime-tab-close-ui-'));
const cwdA = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await mkdir(cwdA, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const entry = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  message: { role, content, timestamp: Date.now(), ...extra },
});
async function seedSession(file, id, projectCwd, title, paragraphs) {
  const records = [{ type: 'session', id, cwd: projectCwd, version: 3, timestamp: new Date().toISOString() }];
  let parentId = null;
  const link = (record) => {
    record.parentId = parentId;
    records.push(record);
    parentId = record.id;
  };
  link({ type: 'message', id: `${id}-u0`, message: { role: 'user', content: title } });
  paragraphs.forEach((text, index) => {
    link(entry(`${id}-a${index}`, null, 'assistant', text));
    link(entry(`${id}-u${index + 1}`, null, 'user', `Suite ${index + 1} : que faut-il vérifier ensuite ?`));
  });
  link(entry(`${id}-final`, null, 'assistant', 'Synthèse disponible. Le panneau reste stable.'));
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
}
const longParagraphs = Array.from(
  { length: 14 },
  (_, i) =>
    `Paragraphe de remplissage ${i + 1} : la conversation doit défiler sur plusieurs écrans pour ` +
    'tester le détachement du défilement pendant les fermetures. '.repeat(6),
);
await seedSession(
  join(sessionDir, 'tab-alpha.jsonl'),
  'tab-alpha',
  cwdA,
  'Tab Alpha : calibrer la sortie',
  longParagraphs,
);
await seedSession(
  join(sessionDir, 'tab-beta.jsonl'),
  'tab-beta',
  cwdA,
  'Tab Beta : préparer la distribution',
  longParagraphs.slice(0, 3),
);

async function sessionLineCount(file) {
  const raw = await readFile(file, 'utf8');
  return raw.trim().split('\n').length;
}
const historyBefore = {
  alpha: await sessionLineCount(join(sessionDir, 'tab-alpha.jsonl')),
  beta: await sessionLineCount(join(sessionDir, 'tab-beta.jsonl')),
};

const starts = [];
let cancellations = 0;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [
      { id: 'fixture/tabclose', name: 'Tab-close fixture model', provider: 'fixture', reasoning: true },
    ],
    default: { model: 'fixture/tabclose', thinking: 'medium' },
  }),
  async start(input) {
    starts.push({ sessionId: input.sessionId || null });
    let resolveDone;
    const done = new Promise((resolveCompletion) => {
      resolveDone = resolveCompletion;
    });
    return {
      done,
      async finish(status = 'completed') {
        const result = { kind: 'done', sessionId: input.sessionId, status, code: 0 };
        input.onEvent(result);
        resolveDone(result);
        return result;
      },
      cancel() {
        cancellations++;
        return this.finish('stopped');
      },
    };
  },
  async close() {},
};

const app = createApp({ runtime, agentHome: join(temp, 'agent'), sessionDir, dataDir, initialCwd: cwdA });
await app.store.project({ cwd: cwdA });
await mkdir(join(temp, 'agent'), { recursive: true });
let roadmapDoc = await app.roadmap.read(cwdA);
roadmapDoc = await app.roadmap.mutate(cwdA, { action: 'init', expectedRevision: roadmapDoc.revision });
roadmapDoc = await app.roadmap.mutate(cwdA, {
  action: 'vision',
  expectedRevision: roadmapDoc.revision,
  text: 'Fermer les onglets vite, sans rien perdre.',
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
const checks = [];
const measurements = {};
function step(text) {
  checks.push(text);
  console.log(`ok - ${text}`);
}
async function seedSelection(context, selection) {
  await context.addInitScript((sel) => {
    if (!localStorage.getItem('prime-studio.selection'))
      localStorage.setItem('prime-studio.selection', JSON.stringify(sel));
  }, selection);
}
async function layoutSignature(page) {
  return page.evaluate(() => ({
    groups: [...document.querySelectorAll('[data-dock-group]')].map((group) => ({
      id: group.dataset.dockGroup,
      tabs: [...group.querySelectorAll('button[data-dock-tab]')].map((tab) => tab.dataset.dockTab),
      active: group.querySelector('button[data-dock-tab][aria-selected="true"]')?.dataset.dockTab ?? null,
    })),
  }));
}
async function menuItemTexts(page) {
  return page.locator(`${DOCK.contextMenu} [role="menuitem"]`).allTextContents();
}
async function scrollState(page) {
  return page.evaluate(() => ({
    winX: window.scrollX,
    winY: window.scrollY,
    conv: document.querySelector('#conversation-scroll')?.scrollTop ?? null,
  }));
}
async function middleClickTab(page, tabId) {
  const box = await page.locator(`button[data-dock-tab="${tabId}"]`).boundingBox();
  assert.ok(box, `tab ${tabId} must have a box for the middle-click`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  // A missed autoscroll guard would start scrolling on the next move.
  await page.mouse.move(x + 40, y + 30);
}
async function dragState(page) {
  return page.evaluate(() => ({
    dragging: !!document.querySelector('#dock-workspace.is-dragging'),
    insertionVisible: !!document.querySelector('.dock-tab-insertion:not([hidden])'),
    previewVisible: !!document.querySelector('.dock-drop-preview:not([hidden])'),
  }));
}

let proofWritten = false;
async function writeProof(extra = {}) {
  const payload = {
    version: 1,
    status: extra.status || 'pass',
    failure: extra.failure || null,
    checks,
    measurements,
    runs: { starts: starts.length, cancellations },
    errors,
    notes: extra.notes || [],
    at: new Date().toISOString(),
  };
  await mkdir(dirname(PROOF_PATH), { recursive: true });
  await writeFile(PROOF_PATH, JSON.stringify(payload, null, 2));
  proofWritten = true;
}

let page;
let context;
try {
  await mkdir(OUT_ROOT, { recursive: true });
  context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  await seedSelection(context, { cwd: cwdA, sessionId: 'tab-alpha', projectOverview: false });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) =>
    errors.push(String(error?.stack || error?.message || error).slice(0, 1200)),
  );
  page.on('dialog', async (dialog) => {
    errors.push(`unexpected native dialog (${dialog.type()}): ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });

  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  await page.locator('#session-list .session-select').filter({ hasText: 'Tab Alpha' }).click();
  await expect(page.locator('#detail-session-id')).toContainText('tab-alpha', { timeout: 10000 });
  await page.locator(DOCK.openButton).click();
  await expect(page.locator(DOCK.dialog)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.toggle).check();
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.closeSettings).click();

  let sig = await layoutSignature(page);
  assert.equal(sig.groups.length, 2, 'default dock has two groups');
  const tools = sig.groups.find((group) => group.tabs.includes('roadmap'));
  assert.deepEqual(tools.tabs, ['roadmap', 'session', 'agents', 'files'], 'default tools group intact');
  assert.equal(tools.active, 'roadmap', 'roadmap starts active');
  step('Boot FR: docked with the default two groups.');

  // Right-click menu on an inactive tab: the close entry is short.
  await page.locator('button[data-dock-tab="session"]').click({ button: 'right' });
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  const frTexts = (await menuItemTexts(page)).map((text) => text.trim());
  assert.equal(frTexts[1], 'Fermer', `close entry is exactly « Fermer », got ${JSON.stringify(frTexts)}`);
  assert.ok(
    frTexts.filter((text) => text.startsWith('Fermer ') && text !== 'Fermer les autres').length === 0,
    `no panel name in the close entry, got ${JSON.stringify(frTexts)}`,
  );
  measurements.menuFr = frTexts;
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.contextMenu)).toBeHidden({ timeout: 10000 });
  const originFocus = await page.evaluate(() => document.activeElement?.dataset?.dockTab || null);
  assert.equal(originFocus, 'session', 'Escape restores focus to the right-clicked tab');
  step('Menu FR: close entry reads exactly « Fermer »; Escape restores origin focus.');

  // Chrome × keeps its descriptive accessible label.
  const closeLabel = await page.locator('[data-dock-close="roadmap"]').first().getAttribute('aria-label');
  assert.ok(
    closeLabel && closeLabel !== 'Fermer' && /^Fermer /.test(closeLabel),
    `× stays descriptive, got ${JSON.stringify(closeLabel)}`,
  );
  measurements.chromeCloseLabelFr = closeLabel;
  step(`Chrome × FR keeps its descriptive label (${closeLabel}).`);

  // Draft + scroll baseline on the surviving conversation panel.
  await page.locator('#composer').fill('BROUILLON-MIDDLE-1');
  const draftBefore = await page.locator('#composer').inputValue();
  const scrollBefore = await scrollState(page);

  // Middle-click an INACTIVE tab in the other group.
  await middleClickTab(page, 'session');
  await expect(page.locator('button[data-dock-tab="session"]')).toHaveCount(0, { timeout: 10000 });
  sig = await layoutSignature(page);
  const toolsAfterInactive = sig.groups.find((group) => group.id === tools.id);
  assert.deepEqual(
    toolsAfterInactive.tabs,
    ['roadmap', 'agents', 'files'],
    'only the middle-clicked tab left',
  );
  assert.equal(toolsAfterInactive.active, 'roadmap', 'group active tab unchanged');
  assert.ok(
    sig.groups.some((group) => group.tabs.includes('conversation')),
    'conversation group untouched',
  );
  assert.equal(await page.locator('#composer').inputValue(), draftBefore, 'surviving draft kept');
  const scrollAfterInactive = await scrollState(page);
  assert.ok(
    Math.abs(scrollAfterInactive.winY - scrollBefore.winY) <= 2 &&
      scrollAfterInactive.conv === scrollBefore.conv,
    `no autoscroll after middle-close, got ${JSON.stringify({ scrollBefore, scrollAfterInactive })}`,
  );
  measurements.scrollInactive = { scrollBefore, scrollAfterInactive };
  assert.deepEqual(
    await dragState(page),
    { dragging: false, insertionVisible: false, previewVisible: false },
    'no drag leftovers',
  );
  assert.equal(starts.length, 0, 'middle-close starts no run');
  assert.equal(cancellations, 0, 'middle-close cancels nothing');
  assert.deepEqual(
    {
      alpha: await sessionLineCount(join(sessionDir, 'tab-alpha.jsonl')),
      beta: await sessionLineCount(join(sessionDir, 'tab-beta.jsonl')),
    },
    historyBefore,
    'history files untouched by middle-close',
  );
  step('Middle-click closes the inactive tab: group intact, draft/scroll/history kept, no drag, no run.');

  // Left/right gestures unchanged.
  await page.locator('button[data-dock-tab="agents"]').click();
  await expect(page.locator('button[data-dock-tab="agents"][aria-selected="true"]')).toBeAttached({
    timeout: 10000,
  });
  await page.locator('button[data-dock-tab="agents"]').click({ button: 'right' });
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.contextMenu)).toBeHidden({ timeout: 10000 });
  step('Left activates, right opens the menu, Escape closes it: gestures unchanged.');

  // Middle-click the ACTIVE tab: it closes, focus falls back inside its group.
  await middleClickTab(page, 'agents');
  await expect(page.locator('button[data-dock-tab="agents"]')).toHaveCount(0, { timeout: 10000 });
  sig = await layoutSignature(page);
  const toolsAfterActive = sig.groups.find((group) => group.id === tools.id);
  assert.deepEqual(toolsAfterActive.tabs, ['roadmap', 'files'], 'active tab removed, siblings kept');
  assert.equal(
    toolsAfterActive.active,
    'roadmap',
    'fallback is the group head (pre-existing removePanel rule)',
  );
  const toolsSelected = await page.evaluate(
    (groupId) =>
      document.querySelector(`[data-dock-group="${groupId}"] button[aria-selected="true"]`)?.dataset
        .dockTab || null,
    tools.id,
  );
  assert.equal(toolsSelected, 'roadmap', 'closed group keeps its in-group head selected');
  const focusAfterActive = await page.evaluate(
    () => document.activeElement?.dataset?.dockTab || document.activeElement?.tagName || null,
  );
  measurements.focusAfterActiveMiddle = focusAfterActive;
  // Pre-existing removePanel rule (shared with the × button and the menu entry):
  // keyboard focus follows the conversation-first fallback across groups, so it
  // lands on « conversation », never on the closed panel. Not changed here.
  assert.equal(focusAfterActive, 'conversation', 'focus follows the shared conversation-first fallback');
  assert.equal(
    await page.locator('#composer').inputValue(),
    draftBefore,
    'draft still kept after active close',
  );
  assert.ok(
    sig.groups.some((group) => group.tabs.includes('conversation')),
    'conversation still docked',
  );
  await expect(page.locator('#detail-session-id')).toContainText('tab-alpha', { timeout: 10000 });
  step(
    'Middle-click closes the active tab with the shared conversation-first keyboard focus; survivor intact.',
  );

  // Reopen through the real Add-tab submenu: the panel returns, history intact.
  await page.locator(`[data-dock-group="${tools.id}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await expect(page.locator(DOCK.addMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(`${DOCK.addMenu} [data-dock-add="session"]`).click();
  await expect(page.locator('button[data-dock-tab="session"]')).toBeAttached({ timeout: 10000 });
  assert.deepEqual(
    {
      alpha: await sessionLineCount(join(sessionDir, 'tab-alpha.jsonl')),
      beta: await sessionLineCount(join(sessionDir, 'tab-beta.jsonl')),
    },
    historyBefore,
    'reopen restores without touching history',
  );
  assert.equal(starts.length, 0, 'reopen starts no run');
  await page.screenshot({ path: join(OUT_ROOT, 'tab-close-fr.png'), animations: 'disabled' });
  step('Reopen via Add-tab restores the panel; history and runs untouched.');
  await context.close();

  // English locale: short « Close » entry, descriptive × label.
  const enContext = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  await seedSelection(enContext, { cwd: cwdA, sessionId: 'tab-alpha', projectOverview: false });
  const english = await enContext.newPage();
  english.setDefaultTimeout(15000);
  english.on('pageerror', (error) => errors.push(String(error?.message || error).slice(0, 1200)));
  await english.goto(url);
  await expect(english.locator('#connection-label')).toContainText('connected', { timeout: 20000 });
  await english.locator(DOCK.openButton).click();
  await expect(english.locator(DOCK.dialog)).toBeVisible({ timeout: 10000 });
  await english.locator(DOCK.toggle).check();
  await expect(english.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  await english.locator(DOCK.closeSettings).click();
  await english.locator('button[data-dock-tab="session"]').click({ button: 'right' });
  await expect(english.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  const enTexts = (await menuItemTexts(english)).map((text) => text.trim());
  assert.equal(enTexts[1], 'Close', `EN close entry is exactly « Close », got ${JSON.stringify(enTexts)}`);
  measurements.menuEn = enTexts;
  const enCloseLabel = await english
    .locator('[data-dock-close="roadmap"]')
    .first()
    .getAttribute('aria-label');
  assert.ok(
    enCloseLabel && enCloseLabel !== 'Close' && /^Close /.test(enCloseLabel),
    `EN × stays descriptive, got ${JSON.stringify(enCloseLabel)}`,
  );
  measurements.chromeCloseLabelEn = enCloseLabel;
  await english.screenshot({ path: join(OUT_ROOT, 'tab-close-en-menu.png'), animations: 'disabled' });
  await english.keyboard.press('Escape');
  await enContext.close();
  step('Menu EN: close entry reads exactly « Close »; × stays descriptive.');

  assert.equal(cancellations, 0, 'No flow in this test may cancel a run');
  assert.deepEqual(errors, [], `No page errors expected, got ${JSON.stringify(errors)}`);
  step(`Tab-close UI complete: ${checks.length} checks, ${starts.length} starts, 0 cancels, 0 page errors.`);
  await writeProof({ status: 'pass' });
} catch (error) {
  try {
    await page?.screenshot({ path: join(OUT_ROOT, 'tab-close-failure.png') }).catch(() => {});
  } catch {}
  if (!proofWritten) {
    try {
      await writeProof({ status: 'failed', failure: String(error?.message || error).slice(0, 2000) });
    } catch {}
  }
  throw error;
} finally {
  await browser.close();
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
