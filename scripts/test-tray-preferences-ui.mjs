// Regression: tray "Studio preferences" froze the window. The native shell
// called showModal() on the dock-hidden Preferences dialog: an invisible modal
// made the whole page inert. Runs the exact script built in main.rs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';

const rust = await readFile('src-tauri/src/main.rs', 'utf8');
const raw = rust.match(/"(\(\(\) => \{\{ const shell.*?\}\}\)\(\))"/)?.[1];
assert.ok(raw, 'settings_panel_script source found in main.rs');
const SHELL = 'http://tauri.localhost/index.html?settings';
const script = raw.replaceAll('{{', '{').replaceAll('}}', '}').replace('{shell:?}', JSON.stringify(SHELL));

const fixture = await preferencesFixture();
const browser = await launchStudioBrowser();
try {
  for (const legacyPage of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url);
    await expect(page.locator('#open-settings')).toBeVisible();
    // Docked default: the dialog is a hidden dock panel before the tray click.
    assert.equal(await page.locator('#settings-dialog').isHidden(), true);
    // legacyPage simulates an older served Studio without the open hook.
    if (legacyPage) await page.evaluate(() => delete window.__PRIME_STUDIO_OPEN_PREFERENCES__);
    await page.evaluate(script);
    const dialog = page.locator('#settings-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
    assert.equal(await dialog.evaluate((d) => d.matches(':modal') && d.getClientRects().length > 0), true);
    // Never an invisible modal: the point under the cursor is the dialog itself.
    const box = await dialog.boundingBox();
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('#settings-dialog') !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    assert.equal(hit, true, 'dialog receives clicks');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // After closing, the page is interactive again (no inert leftovers).
    await page.locator('#open-settings').click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    // Second tray click still works.
    await page.evaluate(script);
    await expect(dialog).toBeVisible();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Tray preferences passed: docked hidden dialog opens visible and clickable (hook and legacy fallback), closes cleanly, reopens.');
} finally {
  await browser.close();
  await fixture.close();
}
