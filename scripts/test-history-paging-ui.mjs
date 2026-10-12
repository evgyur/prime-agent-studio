// Real-app, isolated history paging/window regression. No user Studio or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';
const out = resolve('.local/dynamic-history');
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'studio-history-pages-'));
const cwd = join(temp, 'HistoryFixture'),
  sessionDir = join(temp, 'sessions');
await Promise.all([cwd, sessionDir].map((p) => mkdir(p)));
const count = { upper: 1000, lower: 240 };
const rows = {};
for (const name of ['upper', 'lower']) {
  const id = `paged-${name}`;
  rows[name] = [{ type: 'session', id, cwd, timestamp: '2026-10-01T12:00:00Z' }];
  for (let i = 0; i < count[name]; i++)
    rows[name].push({
      type: 'message',
      id: `${id}-${i}`,
      parentId: i ? `${id}-${i - 1}` : id,
      timestamp: new Date(1790856000000 + i * 1000).toISOString(),
      message: {
        role: i % 2 ? 'assistant' : 'user',
        stopReason: 'stop',
        content:
          `${name.toUpperCase()} HISTORY ${i}\n\n` +
          'Historical **content** with an inline `value`. No model call.\n\n'.repeat(3),
      },
    });
  await writeFile(join(sessionDir, id + '.jsonl'), rows[name].map(JSON.stringify).join('\n') + '\n');
}
let modelCalls = 0;
const app = createApp({
  initialCwd: cwd,
  sessionDir,
  dataDir: join(temp, 'data'),
  agentHome: join(temp, 'agent'),
  commands: { list: async () => ({ commands: [] }) },
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [{ id: 'fixture/model', name: 'Fixture', provider: 'fixture' }],
      default: { model: 'fixture/model' },
    }),
    start: async () => {
      modelCalls++;
      throw Error('No models allowed');
    },
    close: async () => {},
  },
});
let browser, page;
const errors = [],
  history = [],
  checks = [];
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
try {
  await app.store.project({ cwd });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await launchStudioBrowser();
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1500 },
    locale: 'fr-FR',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.addInitScript(
    ({ cwd }) => {
      const group = (id, panel) => ({ kind: 'group', id, panels: [panel], active: panel });
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'paged-upper', projectOverview: false }),
      );
      localStorage.setItem(
        'prime-studio.docking.layout',
        JSON.stringify({
          version: 3,
          enabled: true,
          root: {
            kind: 'split',
            id: 'outer',
            dir: 'row',
            ratio: 0.78,
            first: {
              kind: 'split',
              id: 'vertical',
              dir: 'column',
              ratio: 0.5,
              first: group('top', 'conversation'),
              second: group('bottom', 'conv:lower'),
            },
            second: group('right', 'session'),
          },
        }),
      );
      localStorage.setItem(
        'prime-studio.docking.conversations',
        JSON.stringify({
          version: 1,
          activeId: 'conversation',
          entries: ['upper', 'lower'].map((name, i) => ({
            id: i ? 'conv:lower' : 'conversation',
            kind: 'session',
            nonce: `paged-${name}`,
            sessionId: `paged-${name}`,
            projectCwd: cwd,
            execCwd: cwd,
            viewRunId: null,
            gen: null,
          })),
        }),
      );
    },
    { cwd },
  );
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (response) => {
    const parsed = new URL(response.url());
    if (parsed.pathname !== '/api/history') return;
    try {
      const body = await response.json();
      history.push({
        id: parsed.searchParams.get('id'),
        before: parsed.searchParams.get('before'),
        limit: parsed.searchParams.get('limit'),
        status: response.status(),
        count: body.messages?.length,
        page: body.historyPage,
        bytes: Buffer.byteLength(JSON.stringify(body)),
      });
    } catch {}
  });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(url) ? route.continue() : route.abort(),
  );
  await page.goto(url);
  const upper = page.locator('#messages'),
    lower = page.locator('.cvw-messages').last();
  const upperScroll = page.locator('#conversation-scroll');
  const upperInput = page.locator('#composer'),
    lowerInput = page.locator('[data-cvw="composer"]');
  await expect(upper).toContainText('UPPER HISTORY 999', { timeout: 15000 });
  await expect(lower).toContainText('LOWER HISTORY 239', { timeout: 15000 });
  assert.ok(
    history.filter((h) => h.status === 200).every((h) => h.limit === '80' && h.count <= 80),
    'initial UI requests must be bounded',
  );
  assert.ok(history.some((h) => h.id === 'paged-upper' && h.page?.total === 1000));
  assert.ok((await upper.locator(':scope > .message').count()) <= 80);
  assert.ok((await lower.locator(':scope > .message').count()) <= 80);
  check('two restored panes load bounded tails; total history count remains authoritative');
  await upperInput.fill('upper draft stays');
  await lowerInput.fill('lower draft stays');
  await page.locator('[data-dock-tab="conversation"]').click();
  // Hold one older response while focus moves. Its completion must stay in its owner.
  let pendingRoute;
  let hold = true;
  await page.route('**/api/history?**', async (route) => {
    if (new URL(route.request().url()).searchParams.has('before') && hold) {
      pendingRoute = route;
      return;
    }
    await route.continue();
  });
  await upperScroll.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => !!pendingRoute, { timeout: 10000 }).toBe(true);
  const anchor = () =>
    upperScroll.evaluate((scroller) => {
      const box = scroller.getBoundingClientRect();
      const node = [...scroller.querySelectorAll('.messages > .message')].find((n) => {
        const b = n.getBoundingClientRect();
        return b.bottom > box.top + 10 && b.top < box.bottom;
      });
      return node
        ? {
            id: node.dataset.messageId,
            top: node.getBoundingClientRect().top - box.top,
            scroll: scroller.scrollTop,
          }
        : null;
    });
  const before = await anchor();
  assert.ok(before?.id, 'visible message anchor before loading');
  await lowerInput.fill('lower draft still focused');
  hold = false;
  await pendingRoute.continue();
  const olderButton = upper.getByRole('button', { name: 'Charger les messages précédents', exact: true });
  await expect(olderButton).toBeEnabled({ timeout: 15000 });
  const after = await upperScroll.evaluate((scroller, id) => {
    const node = [...scroller.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === id);
    return node ? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
  }, before.id);
  assert.ok(
    after !== null && Math.abs(after - before.top) < 3,
    `prepend anchor moved: ${JSON.stringify({ before, after })}`,
  );
  await expect(lowerInput).toBeFocused();
  await expect(upperInput).toHaveValue('upper draft stays');
  await expect(lowerInput).toHaveValue('lower draft still focused');
  await page.locator('[data-dock-tab="conversation"]').click();
  const refocus = await upperScroll.evaluate((scroller, id) => {
    const node = [...scroller.querySelectorAll('[data-message-id]')].find((n) => n.dataset.messageId === id);
    return node ? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
  }, before.id);
  assert.ok(
    refocus !== null && Math.abs(refocus - before.top) < 3,
    'refocusing owner keeps the paged reading position',
  );
  check('older-page completion preserves anchor, both drafts and other pane focus');
  // Walk back to the beginning through the actual UI; no missing/truncated messages.
  for (let attempt = 0; attempt < 16; attempt++) {
    const prior = history.filter((h) => h.id === 'paged-upper' && h.before && h.status === 200).at(-1);
    if (prior?.page?.hasBefore === false) break;
    const completed = history.filter((h) => h.id === 'paged-upper' && h.before && h.status === 200).length;
    await upperScroll.hover();
    await page.mouse.wheel(0, -100000);
    await expect
      .poll(() => history.filter((h) => h.id === 'paged-upper' && h.before && h.status === 200).length, {
        timeout: 10000,
      })
      .toBeGreaterThan(completed);
    const latest = history.filter((h) => h.id === 'paged-upper' && h.before && h.status === 200).at(-1);
    if (latest?.page?.hasBefore) await expect(olderButton).toBeEnabled({ timeout: 15000 });
    else await expect(olderButton).toBeHidden({ timeout: 15000 });
  }
  await upperScroll.hover();
  await page.mouse.wheel(0, -100000);
  await expect(upper).toContainText('UPPER HISTORY 0', { timeout: 10000 });
  assert.ok(
    (await upper.locator(':scope > .message').count()) <= 80,
    'walking all pages must not mount all history',
  );
  const pages = history.filter((h) => h.id === 'paged-upper' && h.status === 200);
  assert.equal(pages.filter((h) => h.before).at(-1).page.hasBefore, false);
  check('oldest message remains reachable after all pages; connected transcript stays bounded');
  await upperScroll.hover();
  await page.mouse.wheel(0, 10000000);
  await expect(upper).toContainText('UPPER HISTORY 999', { timeout: 10000 });
  await expect(upperInput).toHaveValue('upper draft stays');
  assert.ok((await upper.locator(':scope > .message').count()) <= 80);
  check('returning to latest remounts correct tail without losing draft');
  // Export continues to use the complete unpaged contract.
  const full = await (await fetch(`${url}/api/history?id=paged-upper`)).json();
  assert.equal(full.messages.length, 1000);
  assert.equal(full.historyPage, undefined);
  assert.equal(full.messages[0].text.includes('UPPER HISTORY 0'), true);
  check('complete export/API history remains available independently of UI paging');
  await page.screenshot({ path: join(out, 'paging-two-pane.png') });
  assert.deepEqual(errors, []);
  assert.equal(modelCalls, 0);
  console.log(JSON.stringify({ checks, history, errors, modelCalls }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(out, 'paging-ui-failure.png') }).catch(() => {});
    const dom = await page
      .evaluate(() => ({
        active: document.activeElement?.outerHTML,
        panes: [...document.querySelectorAll('.conversation-scroll,.cvw-scroller')].map((s) => ({
          class: s.className,
          top: s.scrollTop,
          height: s.scrollHeight,
          client: s.clientHeight,
          rows: [...s.querySelectorAll('.messages > .message')].map((n) => ({
            id: n.dataset.messageId,
            top: n.getBoundingClientRect().top - s.getBoundingClientRect().top,
            height: n.getBoundingClientRect().height,
          })),
          bar: s.querySelector('.conv-window-topbar')?.outerHTML,
        })),
      }))
      .catch(() => null);
    await writeFile(
      join(out, 'paging-ui-failure.json'),
      JSON.stringify({ error: String(error), dom }, null, 2),
    );
  }
  throw error;
} finally {
  await writeFile(
    join(out, 'paging-ui-proof.json'),
    JSON.stringify({ checks, history, errors, modelCalls }, null, 2),
  );
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
