// Automatic update check + sidebar badge. UI-only Tauri adapter, fake clock:
// no real updater, installer, network or installed Studio.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createStabilityFixture } from './fixtures/session-stability.mjs';
import { mockDesktopUpdates } from './fixtures/desktop-updates.mjs';

const fixture = await createStabilityFixture();
const browser = await launchStudioBrowser({ channel: 'chrome' });
const checks = (page) =>
  page.evaluate(() => window.checkArgs.map((args) => args?.includePrereleases === true));

async function open({ mode = 'available', beta = false } = {}) {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  await mockDesktopUpdates(context, { mode });
  // Record the channel of every check and echo it like the native command.
  await context.addInitScript((beta) => {
    if (beta) localStorage.setItem('prime-studio.updates.includePrereleases', 'true');
    window.checkArgs = [];
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command !== 'desktop_update_check') return result;
      window.checkArgs.push(args);
      return { ...result, includePrereleases: args?.includePrereleases === true };
    };
  }, beta);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(fixture.url);
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  return { context, page, errors };
}
const badge = (page) => page.locator('#update-available');
const shortcut = (page) => page.locator('.settings-shortcut');

try {
  // 1. Stable channel: hidden until the startup check, then shown in the footer.
  let { context, page, errors } = await open();
  await expect(badge(page)).toBeHidden();
  assert.deepEqual(await checks(page), [], 'no check before the startup delay');
  await page.clock.runFor(10_000);
  await expect(badge(page)).toBeVisible();
  await expect(badge(page)).toHaveText('Mise à jour disponible');
  await expect(badge(page)).toHaveAttribute('title', /2\.9\.4/);
  await expect(shortcut(page)).toBeHidden();
  assert.deepEqual(await checks(page), [false], 'one stable check at startup');
  const footer = await page.locator('.sidebar-settings-row').boundingBox();
  const button = await badge(page).boundingBox();
  assert.ok(
    button.y >= footer.y && button.y + button.height <= footer.y + footer.height + 1,
    'badge sits in the Preferences row',
  );
  await page.screenshot({
    path: 'test-results/update-badge-fr.png',
    clip: { x: 0, y: footer.y - 60, width: 320, height: footer.height + 80 },
  });
  await badge(page).click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#studio-update-install')).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('ok - startup check shows the badge, click opens Updates');
  await context.close();

  // 2. Up to date at startup, new release 30 minutes later.
  ({ context, page, errors } = await open({ mode: 'current' }));
  await page.clock.runFor(10_000);
  await expect(badge(page)).toBeHidden();
  await expect(shortcut(page)).toBeVisible();
  await page.evaluate(() => (window.updateFixture.mode = 'available'));
  await page.clock.runFor(29 * 60_000);
  assert.equal((await checks(page)).length, 1, 'no second check before 30 minutes');
  await page.clock.runFor(60_000);
  await expect(badge(page)).toBeVisible();
  assert.equal((await checks(page)).length, 2, 'periodic check every 30 minutes');
  assert.deepEqual(errors, []);
  console.log('ok - periodic check every 30 minutes');
  await context.close();

  // 3. Beta setting: the automatic check uses the prerelease channel.
  ({ context, page, errors } = await open({ beta: true }));
  await page.clock.runFor(10_000);
  await expect(badge(page)).toBeVisible();
  assert.deepEqual(await checks(page), [true], 'beta channel checked');
  console.log('ok - beta setting checks prereleases');
  await context.close();

  // 4. Network error: silent, no badge, no error toast.
  ({ context, page, errors } = await open({ mode: 'offline' }));
  await page.clock.runFor(10_000);
  await expect(badge(page)).toBeHidden();
  await expect(page.locator('.toast.error')).toHaveCount(0);
  assert.equal((await checks(page)).length, 0, 'failed check throws before recording');
  assert.deepEqual(errors, []);
  console.log('ok - failed automatic check stays silent');
  await context.close();
  console.log('PASS update badge UI');
} finally {
  await browser.close();
  await fixture.close();
}
