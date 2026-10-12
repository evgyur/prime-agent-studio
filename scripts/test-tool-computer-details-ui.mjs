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
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
      await route.fulfill({ status: 403, json: { error: 'forbidden in fixture' } });
      return;
    }
    await route.fulfill({
      json: {
        supported: true, enabled: false, owner: fakeOwner, busy: false,
        lastAction: FAKE_ACTION, hotkey: FAKE_HOTKEY, backend: 'native',
      },
    });
  });
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

  // Live switch: fake owner becomes B; labels follow without new tabs.
  // Hidden surfaces stay quiet by design (rects-gated targets), so the parked
  // A clone is read after re-activating its tab. No production change.
  fakeOwner = { sessionId: 'sess-b', name: 'Conversation B' };
  await expect.poll(async () => (await readDetails(tabB)).owner, { timeout: 25000 }).toBe(ownerMine);
  await page.locator(`button[data-dock-tab="${tabA}"]`).click();
  await expect.poll(async () => (await readDetails(tabA)).owner, { timeout: 25000 }).toBe('Conversation B');

  assert.ok(methods.length > 0 && methods.every((m) => m === 'GET'), `computer-use must stay GET-only: ${methods}`);
  assert.equal(starts, 0, 'no model/backend start may run in this fixture');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, tabA, tabB, ownerMine, methods: methods.length }));
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
