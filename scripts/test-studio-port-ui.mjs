import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';
import { mkdir } from 'node:fs/promises';

// Preferences System port smoke: mocked Tauri bridge, no app restart, no agents.
// Scenes: steady | fallback | env, FR/EN, dark/light Studio theme.
const f = await preferencesFixture();
let browser;
try {
  browser = await launchStudioBrowser();
  await mkdir('.local/study/port-shots', { recursive: true });
  for (const language of ['fr', 'en']) {
    for (const theme of ['dark', 'light']) {
      const context = await browser.newContext({ locale: language === 'fr' ? 'fr-FR' : 'en-US', viewport: { width: 1280, height: 860 } });
      await context.addInitScript(() => {
        Object.defineProperty(window, '__PRIME_STUDIO_DESKTOP__', { value: true });
        Object.defineProperty(window, '__PRIME_STUDIO_COMPONENTS__', { value: true });
        const params = new URLSearchParams(location.search);
        window.__portScene = params.get('portscene') || 'steady';
        window.__portCalls = [];
        window.__TAURI__ = {
          core: {
            invoke: async (command, args) => {
              window.__portCalls.push([command, args || null]);
              const scene = window.__portScene;
              const current = scene === 'fallback' ? 3189 : scene === 'env' ? 4000 : 3088;
              if (command === 'desktop_port_state')
                return {
                  port: current,
                  envOverride: scene === 'env',
                  movedFrom: scene === 'fallback' ? 3088 : null,
                };
              if (command === 'desktop_port_set') {
                if (scene === 'env') throw new Error('port_env_override');
                if (args?.port === current)
                  return { changed: false, port: current, envOverride: scene === 'env', movedFrom: null };
                if (args?.force === true) return { changed: true, port: args.port };
                return { changed: false, reason: 'agents_running', port: current, activeRuns: 2 };
              }
              if (command === 'desktop_state') return { autostart: true };
              throw new Error(`mocked-unavailable: ${command}`);
            },
          },
        };
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const shot = (scene) => `.local/study/port-shots/studio-${language}-${theme}-${scene}.png`;
      const openSystem = async (scene) => {
        await page.goto(`${f.url}/?portscene=${scene}`);
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.locator('#open-settings').click();
        if (language === 'en') await page.locator('#language-select').selectOption('en');
        await page.locator('#settings-tab-system').click();
        await expect(page.locator('#settings-tab-system')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#settings-port-row')).toBeVisible();
        // Real tab activation with its highlight transition: center the port
        // row in the panel viewport (clear of the dialog footer) and let the
        // nav highlight settle, so shots show one active tab with the port
        // row and its fallback/env note unclipped.
        await page.locator('#settings-port-row').evaluate((row) => row.scrollIntoView({ block: 'center' }));
        await expect(page.locator('#settings-tab-appearance')).toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)',
        );
      };

      // Steady: field filled, effective local URL, no fallback.
      await openSystem('steady');
      await expect(page.locator('#settings-port')).toHaveValue('3088');
      await expect(page.locator('#settings-port-status')).toContainText('127.0.0.1:3088');
      await page.screenshot({ path: shot('steady'), fullPage: true });

      // Fallback: notice names the preferred and effective ports.
      await openSystem('fallback');
      await expect(page.locator('#settings-port')).toHaveValue('3189');
      await expect(page.locator('#settings-port-status')).toContainText('3088');
      await page.screenshot({ path: shot('fallback'), fullPage: true });

      // Env override: field disabled with an explanation.
      await openSystem('env');
      await expect(page.locator('#settings-port')).toBeDisabled();
      await expect(page.locator('#settings-port-apply')).toBeDisabled();
      await expect(page.locator('#settings-port-status')).toContainText('PRIME_STUDIO_DESKTOP_PORT');
      await page.screenshot({ path: shot('env'), fullPage: true });

      // Apply flow: refusal opens the shared confirm; approval forces once.
      await openSystem('steady');
      await page.locator('#settings-port').fill('4002');
      await page.locator('#settings-port-apply').click();
      // Initial confirmation first (no count yet), then the agents refusal.
      await expect(page.locator('#studio-update-confirm')).toBeVisible();
      await expect(page.locator('#studio-update-confirm-note')).toContainText('4002');
      await page.locator('#studio-update-proceed').click();
      await expect(page.locator('#studio-update-confirm-note')).toContainText(
        language === 'fr' ? 'exécution' : 'run',
      );
      await page.screenshot({ path: `.local/study/port-shots/studio-${language}-${theme}-confirm.png` });
      await page.locator('#studio-update-proceed').click();
      await expect(page.locator('#settings-port-status')).toContainText(
        language === 'fr' ? 'redémarre' : 'restarting',
      );
      const calls = await page.evaluate(() => window.__portCalls.filter(([c]) => c === 'desktop_port_set'));
      assert.deepEqual(
        calls.map(([, args]) => args?.force === true),
        [false, true],
        'refusal first, forced retry only after approval',
      );
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`Studio port smoke passed: ${language} ${theme}.`);
    }
  }
} finally {
  await browser?.close();
  await f.close();
}
