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
  return { enabled: true, sessionEnabled: true, pins: [{ path: 'src/session-controller.ts', startLine: 12, endLine: 28 }], exclusions: ['dist', 'vendor'],
    index: { state: 'ready', files: 42, chunks: 186, symbols: 93, updatedAt: '2026-10-19T12:00:00.000Z' },
    dossier: { text: 'Project: Atelier\nRequest: Keep session selection stable.\nPinned evidence: src/session-controller.ts:12-28\nUse the existing session controller and preserve focus.', createdAt: '2026-10-19T12:01:00.000Z', sessionId: 'alpha' } };
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
    if (path.endsWith('/search') && fixture.searchGate) await fixture.searchGate;
    if (path.endsWith('/search')) return route.fulfill({ json: { state: 'ready', results: [
      { path: 'src/session-controller.ts', startLine: 12, endLine: 28, text: 'export function selectSession(id) { return sessions.get(id); }', snippet: 'export function selectSession(id) { return sessions.get(id); }', score: 0.94 },
      { path: 'src/views/conversation-selection-and-focus-manager.ts', startLine: 8, endLine: 20, text: 'export function preserveFocus() { return document.activeElement; }', snippet: 'export function preserveFocus() { return document.activeElement; }', score: 0.81 },
    ] } });
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
    await expect(panel).toContainText('src/session-controller.ts');
    await shot(page, `docked-${width}-${locale}`);
    if (width === 1440 && locale === 'en-US') {
      await expect.poll(() => streams.size).toBeGreaterThan(0);
      const before = fixture.reads; await page.waitForTimeout(5500);
      assert.equal(fixture.reads, before, 'no periodic context GET requests while visible');
      fixture.value.index.files = 73;
      fixture.value.dossier.text = 'SSE evidence changed without refresh or polling.';
      emit(fixture.value);
      await expect(panel).toContainText('SSE evidence changed without refresh or polling.');
      assert.equal(fixture.reads, before, 'SSE snapshot updates without a polling fetch');
      await shot(page, 'sse-updated');
      let release;
      fixture.gate = new Promise((resolve) => { release = resolve; });
      await panel.locator('[data-action="refresh"]').click(); await state(panel, 'loading');
      await shot(page, 'state-loading'); release(); fixture.gate = null; await state(panel, 'ready');
      for (const name of ['disabled', 'empty', 'error', 'indexing', 'ready']) {
        fixture.value = readySnapshot(); fixture.fail = name === 'error';
        if (name === 'disabled') fixture.value.enabled = false;
        if (name === 'empty') { fixture.value.index = { state: 'empty', files: 0, chunks: 0 }; fixture.value.pins = []; fixture.value.dossier = null; }
        if (name === 'indexing') fixture.value.index.state = 'indexing';
        await panel.locator('[data-action="refresh"]').click(); await state(panel, name);
        await shot(page, `state-${name}`);
      }
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
      await panel.locator('[data-control="query"]').fill('session selection');
      await panel.locator('[data-action="search"]').click();
      await expect(panel).toContainText('src/views/conversation-selection-and-focus-manager.ts');
      await shot(page, 'search-results');
      await panel.locator('[data-action="pin-result"]').nth(1).click();
      await expect.poll(() => fixture.value.pins.length).toBe(2);
      await expect(panel.locator('[data-action="pin-result"]').nth(1)).toBeDisabled();
      await panel.locator('[data-action="remove-pin"]').nth(1).click();
      await expect.poll(() => fixture.value.pins.length).toBe(1);
      await expect(panel.locator('[data-action="pin-result"]').nth(1)).toBeEnabled();
      // Refresh must release pending controls and discard a superseded search response.
      let releaseSearch;
      fixture.searchGate = new Promise((resolve) => { releaseSearch = resolve; });
      await panel.locator('[data-control="query"]').fill('delayed search');
      await panel.locator('[data-action="search"]').click(); await state(panel, 'searching');
      await expect(panel.locator('[data-action="search"]')).toBeDisabled();
      await panel.locator('[data-action="refresh"]').click(); await state(panel, 'ready');
      await expect(panel.locator('[data-action="search"]')).toBeEnabled();
      await expect(panel.locator('[data-control="enabled"]')).toBeEnabled();
      const delayedResponse = page.waitForResponse((response) => response.url().endsWith('/context/search'));
      releaseSearch(); fixture.searchGate = null; await delayedResponse;
      await expect(panel.locator('.context-result')).toHaveCount(0);
      await expect(panel.locator('[data-action="search"]')).toBeEnabled();
      console.log('PASS Refresh during delayed search clears pending and ignores stale results');
      await panel.locator('[data-action="rebuild"]').click();
      await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith('/rebuild')).length).toBe(1);
      emit(fixture.value); await state(panel, 'indexing');
      fixture.value.index.state = 'ready'; emit(fixture.value); await state(panel, 'ready');
      assert.ok(fixture.requests.some((r) => r.body?.sessionEnabled === false && r.body?.sessionId === 'alpha'), 'session toggle is scoped to selected session');
      console.log('PASS states, toggles, exclusions, search, rebuild, real SSE and no polling (5500ms)');
    }
    await context.close(); console.log(`PASS docked ${width} ${locale}`);
  }
  for (const [width, light, docked] of [[1440, false, false], [390, false, false], [1440, true, true], [390, true, false]]) {
    const { page, context } = await setup(width, 'en-US', docked, light);
    const panel = await openPanel(page, docked, width); await state(panel, 'ready');
    await shot(page, docked ? 'docked-light' : `classic-${width}${light ? '-light' : ''}`);
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
