
// Visual preview of the desktop onboarding shell with a scripted fresh install.
// Usage: node scripts/preview-desktop-onboarding.mjs <outDir> [locale]
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchStudioBrowser } from './fixtures/browser.mjs';
const out = process.argv[2] || '.local/onboarding-preview';
const locale = process.argv[3] || 'fr-FR';
const scheme = process.argv[4] || 'dark';
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!['index.html', 'desktop.js', 'desktop.css', 'icon.png'].includes(name)) return res.writeHead(404).end();
  const type = { js: 'text/javascript', css: 'text/css', png: 'image/png', html: 'text/html' }[name.split('.').pop()];
  res.setHeader('Content-Type', type);
  res.end(await readFile(join('desktop', name)));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await launchStudioBrowser({ channel: 'chrome' });
try {
  const context = await browser.newContext({ locale, colorScheme: scheme, viewport: { width: 1100, height: 820 } });
  await context.addInitScript(() => {
    window.calls = [];
    window.phase = 'missing';
    const listeners = [];
    window.emitProgress = (payload) => {
      for (const fn of listeners) fn({ payload });
      window.channel?.onmessage?.(payload);
    };
    window.__TAURI__ = {
      event: { listen: async (_, fn) => listeners.push(fn) },
      core: {
        Channel: class { constructor() { window.channel = this; } },
        invoke: async (name, args) => {
          window.calls.push({ name, args });
          if (name === 'desktop_state') return { version: '4.4.2', started: false, imported: false, autostart: false };
          if (name === 'desktop_start') {
            if (window.phase !== 'ready' && !args?.allowUnconfigured) throw 'components_required:missing';
            return new Promise(() => {}); // native navigates away
          }
          if (name === 'desktop_components') {
            if (args.action === 'prepare') {
              if (args.onProgress) window.channel = args.onProgress;
              return new Promise((done) => { window.finishPrepare = done; });
            }
            if (window.phase === 'ready')
              return {
                ready: true, needsStart: true, needsRestart: false, requiredEngine: '0.9.8',
                server: { running: false },
                components: {
                  engine: { status: 'ready', version: '0.9.8' }, npm: { status: 'ready', version: '10.9.4' },
                  uv: { status: 'ready', version: '0.8.22' }, python: { status: 'ready', version: '3.11' },
                  bash: { status: 'ready' },
                },
              };
            return {
              ready: false, requiredEngine: '0.9.8', installedEngine: null, server: { running: false },
              components: {
                node: { status: 'ready', version: '24.21.0' }, engine: { status: 'error', error: 'missing', explicit: false },
                python: { status: 'pending' }, uv: { status: 'missing' },
              },
            };
          }
          if (name === 'desktop_update_status') return { managed: true, running: false, canRestart: false, activeRuns: 0 };
          if (name === 'desktop_update_operation') return { operation: null, log: [] };
          return {};
        },
      },
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const shot = async (n) => { await page.waitForTimeout(400); await page.screenshot({ path: join(out, n + '.png') }); };
  await page.waitForSelector('#components:not([hidden])');
  await shot('1-welcome');
  await page.locator('#components-install').click();
  await page.evaluate(() => window.emitProgress({ component: 'npm', stage: 'download', received: 2_400_000, total: 2_700_000 }));
  await page.evaluate(() => window.emitProgress({ component: 'engine', stage: 'download', received: 9_100_000, total: 21_000_000 }));
  await shot('2-download');
  await page.evaluate(() => window.emitProgress({ component: 'engine', stage: 'verify' }));
  await page.evaluate(() => window.emitProgress({ component: 'engine', stage: 'install' }));
  await page.evaluate(() => window.emitProgress({ component: 'engine', stage: 'dependencies' }));
  await page.waitForTimeout(4200);
  await shot('3-engine-dependencies');
  await page.evaluate(() => window.emitProgress({ component: 'uv', stage: 'download', received: 15_000_000, total: 17_000_000 }));
  await page.evaluate(() => window.emitProgress({ component: 'python', stage: 'python' }));
  await shot('4-python');
  await page.evaluate(() => window.emitProgress({ component: 'engine', stage: 'validation' }));
  await shot('4b-check');
  await page.evaluate(() => { window.phase = 'ready'; });
  await page.evaluate(async () => window.finishPrepare(await window.__TAURI__.core.invoke('desktop_components', { action: 'diagnose' })));
  await shot('5-opening-studio');
  console.log('auto-open calls', JSON.stringify(await page.evaluate(() => window.calls.map((c) => c.name + ':' + (c.args?.action || '')))));
  // Failure scenario on a fresh page.
  await page.reload();
  await page.waitForSelector('#components:not([hidden])');
  await page.evaluate(() => { window.phase = 'missing'; });
  await page.locator('#components-install').click();
  await page.evaluate(() => window.emitProgress({ component: 'engine', stage: 'download', received: 4_000_000, total: 21_000_000 }));
  await page.evaluate(() => window.finishPrepare({ failure: { component: 'engine', error: 'download_failed', logPath: 'C:\\Users\\Studio\\AppData\\Local\\com.primeagent.studio\\engine\\logs\\components.log' } }));
  await shot('6-failure');
  console.log(JSON.stringify(await page.evaluate(() => window.calls.map((c) => c.name + ':' + (c.args?.action || '')))));
} finally {
  await browser.close();
  server.close();
}
