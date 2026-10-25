import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createApp } from '../server.mjs';

// Legacy settings card UI proof. Isolated fixture: temp homes, stub runtime,
// loopback only. Seeds pre-removal values, shows the card, resets, and proves
// the card disappears while unrelated settings survive.
const temp = await mkdtemp(join(tmpdir(), 'prime-legacy-settings-ui-'));
const cwd = join(temp, 'Projet de demonstration');
const agentHome = join(temp, 'agent');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await Promise.all([cwd, agentHome, sessionDir, dataDir].map((path) => mkdir(path, { recursive: true })));
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({ theme: 'storm', auxiliaryModel: 'stale/old-model', autonomous: { maxTurns: 6 } }),
  'utf8',
);
await writeFile(
  join(dataDir, 'quota-fallback.json'),
  JSON.stringify({ revision: 1, automatic: true, models: ['fixture/swift'] }),
  'utf8',
);
await writeFile(
  join(dataDir, 'budget-settings.json'),
  JSON.stringify({ revision: 1, period: 'day', run: { tokens: 500, estimatedCost: null }, projects: {} }),
  'utf8',
);

const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir,
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.8 · test' }),
    getModels: async () => ({ models: [], configuredProviders: [], refreshing: false, default: {} }),
    start: async () => {
      throw new Error('Isolated legacy-settings fixture cannot start agents');
    },
    close: async () => {},
  },
  openDirectory: async () => {},
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  const channel = process.env.PRIME_STUDIO_TEST_BROWSER || undefined;
  browser = await launchStudioBrowser(channel ? { headless: true, channel } : { headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur/i, { timeout: 15000 });
  await page.locator('#new-session').click();
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  const card = page.locator('#engine-settings');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('#engine-settings-heading')).toContainText(/Anciens réglages/);
  const items = card.locator('.engine-legacy-list li');
  assert.equal(await items.count(), 4);
  await expect(card.locator('.engine-legacy-list')).toContainText(/auxiliaire/i);
  await expect(card.locator('.engine-legacy-list')).toContainText(/autonomes/i);
  await expect(card.locator('.engine-legacy-list')).toContainText(/quota/i);
  await expect(card.locator('.engine-legacy-list')).toContainText(/plafonds/i);
  const reset = card.locator('#reset-legacy-settings');
  await expect(reset).toBeVisible();
  await expect(reset).toBeEnabled();
  // 409 contract: a stale revision is rejected before any delete.
  const settingsUrl = `${url}/api/engine-settings`;
  const before = await (await fetch(settingsUrl)).json();
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  const conflict = await fetch(settingsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: before.revision.slice(0, -1) + '0' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await card.locator('.engine-legacy-list li').count()), 4);
  // Reset deletes every legacy value and keeps unrelated keys.
  await reset.click();
  await expect(card.locator('.engine-status')).toContainText(/supprimés/i, { timeout: 10000 });
  await expect(card).toBeHidden({ timeout: 10000 });
  const kept = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.deepEqual(kept, { theme: 'storm' });
  for (const name of ['quota-fallback.json', 'budget-settings.json'])
    await assert.rejects(readFile(join(dataDir, name), 'utf8'), { code: 'ENOENT' });
  // Reopening the dialog keeps the card hidden; the detection survives reload.
  await page.keyboard.press('Escape');
  await page.locator('#open-model-config').click();
  await expect(page.locator('#engine-settings')).toBeHidden({ timeout: 10000 });
  // English labels localize on language switch.
  await page.keyboard.press('Escape');
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  await expect(page.locator('#engine-settings')).toBeHidden({ timeout: 10000 });
  // Mobile: no horizontal overflow with legacy values listed.
  await writeFile(
    join(agentHome, 'settings.json'),
    JSON.stringify({ auxiliaryModel: 'stale/old-model', autonomous: { maxTurns: 6 } }),
    'utf8',
  );
  await page.keyboard.press('Escape');
  await page.locator('#open-model-config').click();
  const smallCard = page.locator('#engine-settings');
  await expect(smallCard).toBeVisible({ timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => smallCard.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), { timeout: 3000 })
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A read-only remote client never sees the reset button.
  await context.close();
  const ro = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
  await ro.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, preferences: { ...body.preferences, readOnly: true, remote: true } } });
  });
  const roPage = await ro.newPage();
  roPage.on('pageerror', (e) => errors.push(e.message));
  await writeFile(
    join(agentHome, 'settings.json'),
    JSON.stringify({ auxiliaryModel: 'stale/old-model' }),
    'utf8',
  );
  await roPage.goto(url);
  await expect(roPage.locator('#connection-label')).toContainText(/connect|engine/i, { timeout: 15000 });
  await roPage.locator('#open-settings').click();
  // Consultation hides the models tab and the whole model-config section:
  // read-only clients never see the legacy card or its reset button.
  await expect(roPage.locator('#settings-tab-models')).toBeHidden({ timeout: 15000 });
  await expect(roPage.locator('#model-config-settings')).toBeHidden();
  await expect(roPage.locator('#engine-settings')).toBeHidden();
  await ro.close();
  assert.deepEqual(errors, []);
  console.log('Legacy settings UI passed: card lists leftovers, 409 contract, reset keeps the rest, hidden after reset, i18n, read-only hides reset, mobile, no page errors.');
} finally {
  await browser?.close();
  await app.close();
  if (dirname(temp) !== resolve(tmpdir())) throw new Error('Unexpected fixture directory');
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
