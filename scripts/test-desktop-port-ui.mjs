import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Launcher port smoke: mocked Tauri bridge, no real app launch, no agents.
// Scenes: steady | fallback | env | recovery, FR/EN, dark/light.
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!['index.html', 'desktop.js', 'desktop.css', 'icon.png'].includes(name)) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    'Content-Type',
    name.endsWith('.js')
      ? 'text/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : name.endsWith('.png')
          ? 'image/png'
          : 'text/html',
  );
  res.end(await readFile(join('desktop', name)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir('.local/study/port-shots', { recursive: true });
const browser = await launchStudioBrowser();

const MOCK = () => {
  const params = new URLSearchParams(location.search);
  window.__portScene = params.get('portscene') || 'steady';
  window.__portCalls = [];
  window.__TAURI__ = {
    event: { listen: async () => {} },
    core: {
      Channel: class {},
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
          return { changed: false, reason: 'agents_running', port: current, activeRuns: 1 };
        }
        if (command === 'desktop_components') {
          if (args?.action === 'diagnose') return { ready: true, components: {} };
          return {};
        }
        if (command === 'desktop_state') return { imported: true, autostart: true };
        if (command === 'desktop_update_status')
          return {
            running: false,
            managed: true,
            version: '4.4.4',
            appVersion: '4.4.4',
            activeRuns: 0,
            canRestart: true,
          };
        if (command === 'desktop_update_operation') return { operation: null };
        if (command === 'desktop_start') {
          if (scene === 'recovery') throw new Error('listen EACCES: permission denied 127.0.0.1:3088');
          return {};
        }
        throw new Error(`mocked-unavailable: ${command}`);
      },
    },
  };
};

const TEXT = {
  'fr-FR': { url: 'Adresse locale', fallback: 'repli automatique', env: 'imposée', apply: 'Appliquer et relancer' },
  'en-US': { url: 'Local address', fallback: 'automatically fell back', env: 'forced', apply: 'Apply and restart' },
};

try {
  for (const locale of ['fr-FR', 'en-US']) {
    for (const colorScheme of ['dark', 'light']) {
      const context = await browser.newContext({ locale, colorScheme, viewport: { width: 900, height: 900 } });
      await context.addInitScript(MOCK);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const shot = (scene) => `.local/study/port-shots/launcher-${locale}-${colorScheme}-${scene}.png`;

      // Steady settings: field filled, effective URL, no fallback.
      await page.goto(`${base}/index.html?settings&portscene=steady`);
      await expect(page.locator('#port-section')).toBeVisible();
      await expect(page.locator('#port-input')).toHaveValue('3088');
      await expect(page.locator('#port-url')).toContainText(TEXT[locale].url);
      await expect(page.locator('#port-url')).toContainText('127.0.0.1:3088');
      await expect(page.locator('#port-fallback')).toBeHidden();
      await expect(page.locator('#port-apply')).toContainText(TEXT[locale].apply);
      await page.screenshot({ path: shot('steady'), fullPage: true });

      // Fallback: notice names the preferred and effective ports.
      await page.goto(`${base}/index.html?settings&portscene=fallback`);
      await expect(page.locator('#port-input')).toHaveValue('3189');
      await expect(page.locator('#port-fallback')).toBeVisible();
      await expect(page.locator('#port-fallback')).toContainText('3088');
      await expect(page.locator('#port-fallback')).toContainText('3189');
      await expect(page.locator('#port-url')).toContainText('127.0.0.1:3189');
      await page.screenshot({ path: shot('fallback'), fullPage: true });

      // Env override: field disabled with an explanation.
      await page.goto(`${base}/index.html?settings&portscene=env`);
      await expect(page.locator('#port-input')).toBeDisabled();
      await expect(page.locator('#port-apply')).toBeDisabled();
      await expect(page.locator('#port-note')).toContainText('PRIME_STUDIO_DESKTOP_PORT');
      await page.screenshot({ path: shot('env'), fullPage: true });

      // Recovery: a failed start reveals the port section on the error screen.
      await page.goto(`${base}/index.html?portscene=recovery`);
      await expect(page.locator('#port-section')).toBeVisible();
      await expect(page.locator('#port-input')).toHaveValue('3088');
      await page.screenshot({ path: shot('recovery'), fullPage: true });

      // Apply flow: refusal opens the restart confirm; approval forces once.
      await page.goto(`${base}/index.html?settings&portscene=steady`);
      await expect(page.locator('#port-section')).toBeVisible();
      await page.locator('#port-input').fill('4002');
      await page.locator('#port-apply').click();
      // Initial confirmation first (no agent line), then the agents refusal.
      await expect(page.locator('#restart-confirm')).toBeVisible();
      await expect(page.locator('#restart-confirm-note')).toContainText('4002');
      await page.locator('#restart-proceed').click();
      await expect(page.locator('#restart-confirm-note')).toContainText(
        locale === 'fr-FR' ? 'agents' : 'Agents',
      );
      await page.screenshot({ path: `.local/study/port-shots/launcher-${locale}-${colorScheme}-confirm.png` });
      await page.locator('#restart-proceed').click();
      await expect(page.locator('#port-note')).toContainText(locale === 'fr-FR' ? 'redémarre' : 'restarting');
      const calls = await page.evaluate(() => window.__portCalls.filter(([c]) => c === 'desktop_port_set'));
      assert.deepEqual(
        calls.map(([, args]) => args?.force !== true),
        [true, false],
        'refusal first, forced retry only after approval',
      );
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`Launcher port smoke passed: ${locale} ${colorScheme}.`);
    }
  }
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
