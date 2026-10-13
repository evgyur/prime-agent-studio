// Isolated browser fixture: Session-clone computer-use details.
// Own fixture server (createApp, ephemeral 127.0.0.1 port, mkdtemp dirs, stub
// fixture models). Fake GET /api/computer-use owner; model starts forbidden
// (runtime.start records a violation, POST /api/computer-use answered 403).
// Menu-driven: two Session tool tabs are minted through the real Add Tab
// submenu and locked through the real dock lock buttons. No user Studio,
// no real desktop, no existing multi-tool script edits.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-tool-computer-details-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await writeFile(join(cwd, 'notes.md'), '# Notes\n');

async function seedSession(file, id, title) {
  const records = [
    { type: 'session', id, cwd, version: 3, timestamp: new Date().toISOString() },
    { type: 'message', id: `${id}-u0`, parentId: null, message: { role: 'user', content: title } },
    {
      type: 'message', id: `${id}-a0`, parentId: `${id}-u0`,
      message: { role: 'assistant', content: `Réponse ${title}` },
    },
  ];
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
}
await seedSession(join(sessionDir, 'sess-a.jsonl'), 'sess-a', 'Session A');
await seedSession(join(sessionDir, 'sess-b.jsonl'), 'sess-b', 'Session B');

let starts = 0;
const methods = [];
const app = createApp({
  initialCwd: cwd,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir: join(temp, 'data'),
  openDirectory: async () => ({ opened: true }),
  runtime: {
    getStatus: async () => ({ available: true }),
    getModels: async () => ({ models: [] }),
    start: async () => {
      starts++;
      throw new Error('model starts forbidden in this fixture');
    },
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const local = `http://127.0.0.1:${app.server.address().port}`;

// Fake desktop status: mutable owner for the live switch (GET only).
let fakeOwner = { sessionId: 'sess-a', name: 'Conversation A' };
const FAKE_ACTION = 'Ouverture de notes.md';
const FAKE_HOTKEY = 'Ctrl+Alt+X';

let browser, page;
const errors = [];
// Flicker probe state (Node side): slow GETs keep the shared status refresh
// pending so reveal/replace/reset transients stay observable.
let getDelayMs = 0;
const getUrls = [];
let getDone = 0;
const postBodies = [];
const sessionTabs = () => page.locator('button[data-dock-tab^="tool:session:"]');
async function tabIds() {
  return page.evaluate(() =>
    [...document.querySelectorAll('button[data-dock-tab^="tool:session:"]')].map((b) => b.dataset.dockTab),
  );
}
async function readDetails(tabId) {
  return page.evaluate((id) => {
    const frame = document.getElementById(`dock-view-${id}`);
    const pick = (suffix) => frame?.querySelector(`[id$="${suffix}"]`);
    const text = (el) => el?.textContent ?? null;
    return {
      present: !!frame,
      hidden: pick('computer-use-details')?.hidden ?? null,
      owner: text(pick('computer-use-owner')),
      action: text(pick('computer-use-action')),
      hotkey: text(pick('computer-use-hotkey')),
      warning: text(pick('computer-use-warning')),
    };
  }, tabId);
}
async function addSessionTab() {
  const before = await tabIds();
  await page.locator('button[data-dock-tab]').first().click({ button: 'right' });
  await expect(page.locator('#docking-context-menu')).toBeVisible();
  await page.locator('#docking-context-menu .dock-menu-submenu').first().hover();
  await expect(page.locator('#docking-add-menu')).toBeVisible();
  await page.locator('#docking-add-menu button[data-dock-add="session"]').click();
  await expect
    .poll(async () => (await tabIds()).filter((id) => !before.includes(id)).length, { timeout: 10000 })
    .toBe(1);
  return (await tabIds()).filter((id) => !before.includes(id))[0];
}

try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  // Pathname predicate: the status GET carries ?sessionId=&runId= query params
  // that a plain '**/api/computer-use' glob does not match. Same fixture
  // behavior, no production change.
  await page.route((url) => url.pathname.startsWith('/api/computer-use'), async (route) => {
    methods.push(route.request().method());
    if (route.request().method() !== 'GET') {
      try {
        postBodies.push(JSON.parse(route.request().postData() || '{}'));
      } catch {}
      await route.fulfill({ status: 403, json: { error: 'forbidden in fixture' } });
      return;
    }
    getUrls.push(route.request().url());
    if (getDelayMs) await new Promise((done) => setTimeout(done, getDelayMs));
    await route.fulfill({
      json: {
        supported: true, enabled: false, owner: fakeOwner, busy: false,
        lastAction: FAKE_ACTION, hotkey: FAKE_HOTKEY, backend: 'native',
      },
    });
    getDone += 1;
  });
  // Before/after comparison without touching production: CU_BEFORE_JS serves
  // a saved pre-fix computer-use.js from the same URL, so relative imports
  // (./i18n.js) resolve normally. Unset => current production source.
  if (process.env.CU_BEFORE_JS) {
    const beforeJs = await readFile(process.env.CU_BEFORE_JS, 'utf8');
    await page.route('**/public/computer-use.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: beforeJs }),
    );
  }
  await page.goto(local);
  await expect(page.locator('#connection-label')).toContainText('connect');
  const ownerMine = await page.evaluate(async () => (await import('/public/i18n.js')).t('computer.ownerMine'));

  // Clone A locked to session A through the real lock chrome.
  await page.locator('#session-list .session-select').filter({ hasText: 'Session A' }).click();
  const tabA = await addSessionTab();
  await page.locator(`button[data-dock-tab="${tabA}"]`).click();
  await page.locator(`button.dock-lock[data-dock-lock="${tabA}"]`).click();
  await expect(page.locator(`button.dock-lock[data-dock-lock="${tabA}"]`)).toHaveAttribute('aria-pressed', 'true');

  // Clone B locked to session B; focus stays on B.
  await page.locator('#session-list .session-select').filter({ hasText: 'Session B' }).click();
  const tabB = await addSessionTab();
  await page.locator(`button[data-dock-tab="${tabB}"]`).click();
  await page.locator(`button.dock-lock[data-dock-lock="${tabB}"]`).click();
  await expect(page.locator(`button.dock-lock[data-dock-lock="${tabB}"]`)).toHaveAttribute('aria-pressed', 'true');

  // Owner A: A clone says own conversation, B clone names owner A.
  await page.locator(`button[data-dock-tab="${tabA}"]`).click();
  await expect.poll(async () => (await readDetails(tabA)).owner, { timeout: 20000 }).toBe(ownerMine);
  let detailsA = await readDetails(tabA);
  assert.equal(detailsA.hidden, false);
  assert.equal(detailsA.action, FAKE_ACTION);
  assert.equal(detailsA.hotkey, FAKE_HOTKEY);
  await page.locator(`button[data-dock-tab="${tabB}"]`).click();
  await expect.poll(async () => (await readDetails(tabB)).owner, { timeout: 20000 }).toBe('Conversation A');
  let detailsB = await readDetails(tabB);
  assert.equal(detailsB.hidden, false);
  assert.equal(detailsB.action, FAKE_ACTION);
  assert.equal(detailsB.hotkey, FAKE_HOTKEY);

  // Flicker regression: locked A continuity while the ACTIVE conversation
  // switches A -> B under a slow (pending) shared status refresh. The locked
  // A clone must keep its rendered owner/action/hotkey/warning with stable
  // text nodes: no Loading/dashes reset, no hidden flip, no restructuring.
  // The shared poller itself must follow the ACTIVE conversation (B), never
  // the locked pin, so controls never go stale.
  await page.locator(`button[data-dock-tab="${tabA}"]`).click();
  await expect.poll(async () => (await readDetails(tabA)).owner, { timeout: 20000 }).toBe(ownerMine);
  const baseA = await readDetails(tabA);
  assert.equal(baseA.hidden, false);
  // Make the A -> B switch real: same-id activation skips afterFocus (and
  // its onSessionChange reset) by design, which would render this probe
  // vacuous. Settle on A first, then switch for real under the slow refresh.
  await page.locator('#session-list .session-select').filter({ hasText: 'Session A' }).click();
  await expect.poll(async () => (await readDetails(tabA)).owner, { timeout: 20000 }).toBe(ownerMine);
  getDelayMs = 1500;
  const urlMark = getUrls.length;
  const doneMark = getDone;
  await page.evaluate((id) => {
    const frame = document.getElementById(`dock-view-${id}`);
    const pick = (suffix) => frame?.querySelector(`[id$="${suffix}"]`);
    const section = pick('computer-use-details');
    const textRef = (el) => (el?.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : null);
    window.__flickerObs?.disconnect?.();
    window.__flicker = {
      refs: {
        owner: textRef(pick('computer-use-owner')),
        action: textRef(pick('computer-use-action')),
        hotkey: textRef(pick('computer-use-hotkey')),
        warning: textRef(pick('computer-use-warning')),
      },
      textMuts: 0,
      structMuts: 0,
      hiddenFlips: 0,
    };
    const observer = new MutationObserver((entries) => {
      for (const entry of entries) {
        if (entry.type === 'characterData') window.__flicker.textMuts += 1;
        else if (entry.type === 'attributes') window.__flicker.hiddenFlips += 1;
        else window.__flicker.structMuts += 1;
      }
    });
    if (section)
      observer.observe(section, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['hidden'],
      });
    window.__flickerObs = observer;
  }, tabA);
  await page.locator('#session-list .session-select').filter({ hasText: 'Session B' }).click();
  // Immediate sample: the synchronous onSessionChange reset (if any) lands
  // before any delayed GET resolves, so continuity must already hold here.
  const immediateSample = await readDetails(tabA);
  assert.equal(immediateSample.hidden, baseA.hidden, `locked A hidden must not flip synchronously on switch: ${JSON.stringify(immediateSample)}`);
  assert.equal(immediateSample.owner, baseA.owner, `locked A owner must not reset synchronously on switch: ${JSON.stringify(immediateSample)}`);
  assert.equal(immediateSample.action, baseA.action, `locked A action must not reset synchronously on switch: ${JSON.stringify(immediateSample)}`);
  assert.equal(immediateSample.hotkey, baseA.hotkey, `locked A hotkey must not reset synchronously on switch: ${JSON.stringify(immediateSample)}`);
  assert.equal(immediateSample.warning, baseA.warning, `locked A warning must not reset synchronously on switch: ${JSON.stringify(immediateSample)}`);
  // Sample INSIDE the pending window: the slow refresh for B has not settled.
  const pendingSamples = [immediateSample];
  for (let i = 0; i < 3; i += 1) {
    await page.waitForTimeout(350);
    pendingSamples.push(await readDetails(tabA));
  }
  const probe = await page.evaluate((id) => {
    const frame = document.getElementById(`dock-view-${id}`);
    const pick = (suffix) => frame?.querySelector(`[id$="${suffix}"]`);
    const textRef = (el) => (el?.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : null);
    const refs = window.__flicker.refs;
    return {
      textMuts: window.__flicker.textMuts,
      structMuts: window.__flicker.structMuts,
      hiddenFlips: window.__flicker.hiddenFlips,
      sameOwner: textRef(pick('computer-use-owner')) === refs.owner,
      sameAction: textRef(pick('computer-use-action')) === refs.action,
      sameHotkey: textRef(pick('computer-use-hotkey')) === refs.hotkey,
      sameWarning: textRef(pick('computer-use-warning')) === refs.warning,
    };
  }, tabA);
  await page.evaluate(() => window.__flickerObs?.disconnect?.());
  for (const [index, sample] of pendingSamples.entries()) {
    assert.equal(sample.hidden, baseA.hidden, `locked A hidden must not flip while B refresh pends (sample ${index})`);
    assert.equal(sample.owner, baseA.owner, `locked A owner must not reset while B refresh pends (sample ${index}): ${JSON.stringify(sample)}`);
    assert.equal(sample.action, baseA.action, `locked A action must not reset while B refresh pends (sample ${index}): ${JSON.stringify(sample)}`);
    assert.equal(sample.hotkey, baseA.hotkey, `locked A hotkey must not reset while B refresh pends (sample ${index}): ${JSON.stringify(sample)}`);
    assert.equal(sample.warning, baseA.warning, `locked A warning must not reset while B refresh pends (sample ${index}): ${JSON.stringify(sample)}`);
  }
  assert.equal(probe.textMuts, 0, `locked A details must not mutate text while B refresh pends (saw ${probe.textMuts})`);
  assert.equal(probe.structMuts, 0, 'locked A details must not restructure while B refresh pends');
  assert.equal(probe.hiddenFlips, 0, 'locked A details must not flip hidden while B refresh pends');
  assert.ok(
    probe.sameOwner && probe.sameAction && probe.sameHotkey && probe.sameWarning,
    `locked A text nodes must keep identity: ${JSON.stringify(probe)}`,
  );
  // Let the slow refresh settle, then prove the poller followed the ACTIVE
  // conversation (B), never the locked pin.
  getDelayMs = 0;
  {
    const start = Date.now();
    while (getDone <= doneMark && Date.now() - start < 20000)
      await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(getDone > doneMark, 'slow status refresh for B must settle');
  {
    const fresh = getUrls.slice(urlMark);
    assert.ok(fresh.length > 0, 'switching conversations must re-query computer-use status');
    assert.ok(
      fresh.every((u) => u.includes('sess-b')),
      `status poller must follow the active conversation B: ${fresh.at(-1)}`,
    );
  }

  // Unlocked behavior: a following Session tab tracks the ACTIVE
  // conversation while locked pins stay put.
  const tabC = await addSessionTab();
  await page.locator(`button[data-dock-tab="${tabC}"]`).click();
  await expect.poll(async () => (await readDetails(tabC)).owner, { timeout: 20000 }).toBe('Conversation A');
  await page.locator('#session-list .session-select').filter({ hasText: 'Session A' }).click();
  await expect.poll(async () => (await readDetails(tabC)).owner, { timeout: 20000 }).toBe(ownerMine);
  await page.locator('#session-list .session-select').filter({ hasText: 'Session B' }).click();
  await expect.poll(async () => (await readDetails(tabC)).owner, { timeout: 20000 }).toBe('Conversation A');
  assert.equal((await readDetails(tabA)).owner, ownerMine, 'locked A stays on its pin while C follows');
  assert.equal((await readDetails(tabB)).owner, 'Conversation A', 'locked B stays on its pin while C follows');

  // Live switch: fake owner becomes B; labels follow without new tabs.
  // Hidden surfaces stay quiet by design (rects-gated targets), so the parked
  // A clone is read after re-activating its tab. No production change.
  fakeOwner = { sessionId: 'sess-b', name: 'Conversation B' };
  // tabC (following, added by the flicker phase) parked tabB: parked surfaces
  // stay quiet by design, so re-activate tabB before reading its new labels.
  await page.locator(`button[data-dock-tab="${tabB}"]`).click();
  await expect.poll(async () => (await readDetails(tabB)).owner, { timeout: 25000 }).toBe(ownerMine);
  await page.locator(`button[data-dock-tab="${tabA}"]`).click();
  await expect.poll(async () => (await readDetails(tabA)).owner, { timeout: 25000 }).toBe('Conversation B');

  assert.ok(methods.length > 0 && methods.every((m) => m === 'GET'), `computer-use must stay GET-only: ${methods}`);

  // Actions stay bound to the ACTIVE conversation: enabling from the global
  // toolbar while locked A is visible must address B, never the pin.
  await page.locator('#session-list .session-select').filter({ hasText: 'Session A' }).click();
  await page.locator('#session-list .session-select').filter({ hasText: 'Session B' }).click();
  await page.locator(`button[data-dock-tab="${tabA}"]`).click();
  await expect.poll(async () => (await readDetails(tabA)).owner, { timeout: 20000 }).toBe('Conversation B');
  await expect(page.locator('#computer-use-toggle')).toBeVisible();
  await page.locator('#computer-use-toggle').click();
  {
    const start = Date.now();
    while (postBodies.length < 1 && Date.now() - start < 10000)
      await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(postBodies.length, 1, 'toolbar enable must POST exactly once');
  assert.equal(postBodies[0]?.sessionId, 'sess-b', `enable must address the active conversation B: ${JSON.stringify(postBodies[0])}`);
  assert.ok(!('backend' in (postBodies[0] || {})), 'enable must not POST a per-session backend');
  assert.equal((await readDetails(tabA)).owner, 'Conversation B', 'locked A keeps its pin after the active-side write');

  assert.equal(starts, 0, 'no model/backend start may run in this fixture');
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    tabA,
    tabB,
    tabC,
    ownerMine,
    baseA,
    pendingSamples,
    probe,
    postBody: postBodies[0],
    methods: methods.length,
    getUrls: getUrls.length,
  };
  await writeFile('test-results/tool-computer-details-flicker.json', JSON.stringify(evidence, null, 2));
  await page.locator(`button[data-dock-tab="${tabA}"]`).click();
  await page.screenshot({ path: 'test-results/tool-computer-details-locked.png', animations: 'disabled' });
  console.log(JSON.stringify({ passed: true, tabA, tabB, tabC, ownerMine, methods: methods.length }));
} catch (error) {
  await page?.screenshot({ path: 'test-results/tool-computer-details-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  // Fixture teardown: close the app server (stops its sockets/intervals) so
  // the node process exits; missing this leaked the server and the handle
  // never completed. No production change.
  await app.close();
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
