// Deterministic browser fixtures only. No provider or real project indexing.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const deadline = setTimeout(() => { console.error('Context UI hard timeout (180s)'); process.exit(1); }, 180_000);
const temp = await mkdtemp(join(tmpdir(), 'studio-context-ui-'));
const cwd = join(temp, 'Atelier'), dataDir = join(temp, 'data'), sessionDir = join(temp, 'sessions');
for (const dir of [cwd, dataDir, sessionDir, join(temp, 'agent')]) await mkdir(dir, { recursive: true });
await writeFile(join(sessionDir, 'alpha.jsonl'), [
  { type: 'session', id: 'alpha', cwd, version: 3, timestamp: new Date().toISOString() },
  { type: 'message', id: 'alpha-u', message: { role: 'user', content: 'Context fixture', timestamp: Date.now() } },
].map(JSON.stringify).join('\n') + '\n');
const app = createApp({ dataDir, sessionDir, agentHome: join(temp, 'agent'), initialCwd: cwd, runtime: {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({ models: [{ id: 'fixture/local', provider: 'fixture', name: 'Local' }], default: { model: 'fixture/local' } }),
  async start() { throw new Error('Provider calls forbidden in Context UI fixture'); }, async close() {},
} });
await app.store.project({ cwd });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const streams = new Set();
const events = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  res.write(': fixture connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res));
});
await new Promise((resolve) => events.listen(0, '127.0.0.1', resolve));
const eventUrl = `http://127.0.0.1:${events.address().port}/events`;
const browser = await launchStudioBrowser();
const errors = [];
await mkdir('test-results/context-tab', { recursive: true });
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page has no horizontal overflow');
  assert.equal(await page.locator('.context-panel:visible').evaluate((node) => node.scrollWidth > node.clientWidth + 1), false, 'Context panel has no horizontal overflow');
}
async function shot(page, name) {
  await noOverflow(page);
  if (process.argv.includes('--pending-baseline')) return;
  await page.screenshot({ path: `test-results/context-tab/${name}.png`, fullPage: true });
}
async function shot2e(page, width, locale, name) {
  await noOverflow(page);
  if (process.argv.includes('--pending-baseline')) return;
  await page.screenshot({ path: `test-results/step2e/context-${width}-${locale}-${name}.png`, fullPage: true });
}
async function openPanel(page, docked, width) {
  await page.goto(url);
  if (docked) {
    await page.locator('[data-dock-group]').last().locator('.dock-bar > .dock-chrome-button:not([data-dock-close])').first().click();
    await page.locator('#docking-context-menu [aria-controls="docking-add-menu"]').click();
    await page.locator('#docking-add-menu [data-dock-add="context"]').click();
  } else {
    if (width === 390) await page.locator('#toggle-details').click();
    await page.locator('#detail-context').click();
  }
  return page.locator('.context-panel:visible');
}

function readySnapshot() {
  return { enabled: true, sessionEnabled: true, exclusions: ['dist', 'vendor'],
    index: { state: 'ready', files: 42, chunks: 186, symbols: 93, updatedAt: '2026-10-19T12:00:00.000Z', excludedCount: 2, automaticExclusions: [{ path: '.env.local', reason: 'sensitive-name' }, { path: 'package-lock.json', reason: 'lockfile' }] } };
}
async function setup(width, locale = 'en-US', docked = true, light = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, reducedMotion: 'reduce', isMobile: width === 390, hasTouch: width === 390 });
  await context.addInitScript(({ cwd, layout, light }) => {
    localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'alpha', projectOverview: false }));
    localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
    if (light) localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme: 'light' }));
  }, { cwd, layout: { ...createDefaultLayout(), enabled: docked }, light });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  if (process.argv.includes('--pending-baseline')) {
    const source = await readFile('public/context.js', 'utf8');
    assert.ok(source.includes('stop(); pending = false; key = contextKey();'), 'baseline targets the refresh reset only');
    await page.route('**/public/context.js', (route) => route.fulfill({ contentType: 'text/javascript', body: source.replace('stop(); pending = false; key = contextKey();', 'stop(); key = contextKey();') }));
  }
  const fixture = { value: readySnapshot(), reads: 0, requests: [], fail: false, gate: null };
  await page.route('**/api/projects/*/context**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/events')) return route.continue({ url: eventUrl });
    const body = request.postDataJSON();
    fixture.requests.push({ path, method: request.method(), body });
    if (path.endsWith('/rebuild')) { fixture.value.index.state = 'indexing'; return route.fulfill({ status: 202, json: { queued: true } }); }
    if (request.method() === 'PATCH') {
      const { sessionId, ...changes } = body; Object.assign(fixture.value, changes);
      return route.fulfill({ json: fixture.value });
    }
    fixture.reads++;
    if (fixture.gate) await fixture.gate;
    return fixture.fail ? route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } }) : route.fulfill({ json: fixture.value });
  });
  return { page, context, fixture };
}
async function state(panel, value) { await expect(panel.locator(`[data-state="${value}"]`)).toBeVisible(); }
function emit(value) { for (const stream of streams) stream.write(`event: context\ndata: ${JSON.stringify(value)}\n\n`); }

try {
  for (const width of [1440, 1100]) for (const locale of ['en-US', 'fr-FR']) {
    const { page, context, fixture } = await setup(width, locale);
    const panel = await openPanel(page, true, width); await state(panel, 'ready');
    await expect(panel).toContainText(locale === 'fr-FR' ? 'Index des sources' : 'Source index');
    await expect(panel.locator('[data-control="enabled"]')).toBeChecked();
    const automatic = panel.locator('.context-automatic-exclusions');
    await automatic.locator('summary').click();
    await expect(automatic).toContainText('.env.local');
    await expect(automatic).toContainText('package-lock.json');
    await expect(automatic).toContainText(locale === 'fr-FR' ? 'Nom sensible' : 'Sensitive filename');
    await automatic.scrollIntoViewIfNeeded();
    await shot(page, `exclusions-${width}-${locale}`);
    await panel.locator('.context-heading').scrollIntoViewIfNeeded();
    await shot(page, `docked-${width}-${locale}`);
    await shot2e(page, width, locale, 'docked');
    if (width === 1440 && locale === 'en-US') {
      await expect.poll(() => streams.size).toBeGreaterThan(0);
      const before = fixture.reads; await page.waitForTimeout(5500);
      assert.equal(fixture.reads, before, 'no periodic context GET requests while visible');
      fixture.value.index.files = 73;
      emit(fixture.value);
      await expect(panel).toContainText('73');
      assert.equal(fixture.reads, before, 'SSE snapshot updates without a polling fetch');
      await shot(page, 'sse-updated');
      let release;
      fixture.gate = new Promise((resolve) => { release = resolve; });
      await panel.locator('[data-action="refresh"]').click(); await state(panel, 'loading');
      await shot(page, 'state-loading'); release(); fixture.gate = null; await state(panel, 'ready');
      for (const name of ['disabled', 'empty', 'error', 'indexing', 'ready']) {
        fixture.value = readySnapshot(); fixture.fail = name === 'error';
        if (name === 'disabled') fixture.value.enabled = false;
        if (name === 'empty') { fixture.value.index = { state: 'empty', files: 0, chunks: 0 }; }
        if (name === 'indexing') fixture.value.index.state = 'indexing';
        await panel.locator('[data-action="refresh"]').click(); await state(panel, name);
        await shot(page, `state-${name}`);
      }
      await panel.locator('[data-control="includeGenerated"]').check();
      await expect.poll(() => fixture.value.includeGenerated).toBe(true);
      await panel.locator('[data-control="includeGenerated"]').uncheck();
      await expect.poll(() => fixture.value.includeGenerated).toBe(false);
      await panel.locator('[data-control="enabled"]').uncheck();
      await expect.poll(() => fixture.value.enabled).toBe(false); await state(panel, 'disabled');
      await panel.locator('[data-control="enabled"]').check(); await state(panel, 'ready');
      await panel.locator('[data-control="sessionEnabled"]').uncheck();
      await expect.poll(() => fixture.value.sessionEnabled).toBe(false);
      await panel.locator('[data-control="sessionEnabled"]').check();
      await expect.poll(() => fixture.value.sessionEnabled).toBe(true);
      await panel.locator('[data-control="exclusions"]').fill('dist\nvendor\ngenerated/**');
      await panel.locator('[data-action="save-exclusions"]').click();
      await expect.poll(() => fixture.value.exclusions).toEqual(['dist', 'vendor', 'generated/**']);
      // Dossier, pins and context search were removed: none of their controls may render.
      for (const selector of ['[data-control="query"]', '[data-action="search"]', '[data-action="pin-result"]', '[data-action="remove-pin"]', '.context-result', '.context-dossier']) {
        await expect(panel.locator(selector)).toHaveCount(0);
      }
      assert.ok(!fixture.requests.some((r) => r.path.endsWith('/context/search')), 'no context search requests');
      await shot2e(page, width, locale, 'context-switches-exclusions');
      await panel.locator('[data-action="rebuild"]').click();
      await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith('/rebuild')).length).toBe(1);
      emit(fixture.value); await state(panel, 'indexing');
      fixture.value.index.state = 'ready'; emit(fixture.value); await state(panel, 'ready');
      assert.ok(fixture.requests.some((r) => r.body?.sessionEnabled === false && r.body?.sessionId === 'alpha'), 'session toggle is scoped to selected session');
      console.log('PASS states, toggles, exclusions, rebuild, real SSE and no polling (5500ms)');
    }
    await context.close(); console.log(`PASS docked ${width} ${locale}`);
  }
  for (const [width, light, docked] of [[1440, false, false], [390, false, false], [1440, true, true], [390, true, false]]) {
    const { page, context } = await setup(width, 'en-US', docked, light);
    const panel = await openPanel(page, docked, width); await state(panel, 'ready');
    await shot(page, docked ? 'docked-light' : `classic-${width}${light ? '-light' : ''}`);
    await shot2e(page, width, 'en-US', `classic-${width}${light ? '-light' : ''}`);
    if (!docked) {
      await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
      await expect(page.locator('#detail-context')).toBeFocused();
    }
    await context.close(); console.log(`PASS ${light ? 'light' : 'classic'} ${width}`);
  }
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS Context tab UI');
} finally {
  await browser.close();
  for (const stream of streams) stream.end();
  await new Promise((resolve) => events.close(resolve));
  await app.close(); await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  clearTimeout(deadline);
}
