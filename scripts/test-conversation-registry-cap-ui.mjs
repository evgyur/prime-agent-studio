// Registry-cap UI test: a full conversation registry (24 views, mostly closed)
// must free the OLDEST SAFE closed view when a new conversation is requested,
// and must never evict a closed view that still holds an unsent draft.
// Fixture server + stub runtime only: no real model, account or installed Studio.

import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const CONV_KEY = 'prime-studio.docking.conversations';
const DRAFTS_KEY = 'prime-studio.drafts';
const temp = await mkdtemp(join(tmpdir(), 'prime-registry-cap-ui-'));
const cwd = join(temp, 'Atelier');
for (const dir of [cwd, join(temp, 'sessions'), join(temp, 'data'), join(temp, 'agent')])
  await mkdir(dir, { recursive: true });

const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/cap', name: 'Cap fixture', provider: 'fixture', reasoning: false }],
    default: { model: 'fixture/cap', thinking: 'off' },
  }),
  async start() {
    throw new Error('no run expected');
  },
  async close() {},
};
const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir: join(temp, 'sessions'),
  dataDir: join(temp, 'data'),
  initialCwd: cwd,
});
await app.store.project({ cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

// Primary + 23 closed views = registry full. c1 (oldest) holds an unsent draft.
function sidecar(draftAll) {
  const entries = [
    {
      id: 'conversation',
      kind: 'new',
      sessionId: null,
      projectCwd: cwd,
      execCwd: cwd,
      viewRunId: null,
      nonce: 'p0',
      gen: null,
    },
  ];
  for (let i = 1; i <= 23; i += 1)
    entries.push({
      id: `conv:c${i}`,
      kind: 'new',
      sessionId: null,
      projectCwd: cwd,
      execCwd: cwd,
      viewRunId: null,
      nonce: `n${i}`,
      gen: null,
    });
  const drafts = { 'conv:n1': 'brouillon à garder' };
  if (draftAll) for (let i = 2; i <= 23; i += 1) drafts[`conv:n${i}`] = `brouillon ${i}`;
  return { conv: { version: 1, activeId: 'conversation', entries }, drafts };
}

const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
async function open(draftAll) {
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  const seed = sidecar(draftAll);
  await context.addInitScript(
    ({ seed, cwd, keys }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(keys.conv, JSON.stringify(seed.conv));
      localStorage.setItem(keys.drafts, JSON.stringify(seed.drafts));
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: null, projectOverview: false }),
      );
    },
    { seed, cwd, keys: { conv: CONV_KEY, drafts: DRAFTS_KEY } },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(String(error?.message || error)));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  await page.locator('#open-docking').click();
  await page.locator('#docking-toggle').check();
  await expect(page.locator('#dock-workspace')).toBeVisible();
  await page.locator('#docking-close-settings').click();
  return { context, page };
}
const registry = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)).entries.map((e) => e.id), CONV_KEY);
const drafts = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), DRAFTS_KEY);
const convTabs = (page) => page.locator('.dock-tab.is-conversation').count();

try {
  // 1. Full registry, one safe closed view available: Ctrl+N works.
  let { context, page } = await open(false);
  assert.equal((await registry(page)).length, 24, 'seeded registry is full');
  const tabsBefore = await convTabs(page);
  await page.locator('body').press('Control+n');
  await expect(page.locator('.dock-tab.is-conversation')).toHaveCount(tabsBefore + 1);
  await expect(page.locator('.toast.error')).toHaveCount(0);
  let ids = await registry(page);
  assert.equal(ids.length, 24, 'registry stays at the cap');
  assert.ok(ids.includes('conv:c1'), 'oldest closed view with an unsent draft is kept');
  assert.ok(!ids.includes('conv:c2'), 'oldest safe closed view is evicted');
  assert.equal((await drafts(page))['conv:n1'], 'brouillon à garder', 'draft untouched');
  // A second request frees the next one.
  await page.locator('body').press('Control+n');
  await expect(page.locator('.dock-tab.is-conversation')).toHaveCount(tabsBefore + 2);
  ids = await registry(page);
  assert.ok(!ids.includes('conv:c3') && ids.includes('conv:c1'), 'next oldest safe view evicted');
  console.log('ok - full registry frees the oldest safe closed view');
  await context.close();

  // 2. Every closed view holds a draft: refuse, evict nothing.
  ({ context, page } = await open(true));
  const before = await registry(page);
  const tabs2 = await convTabs(page);
  await page.locator('body').press('Control+n');
  await expect(page.locator('.toast.error')).toContainText('brouillon');
  assert.deepEqual(await registry(page), before, 'nothing evicted when every closed view holds work');
  assert.equal(await convTabs(page), tabs2, 'no tab created');
  console.log('ok - registry refuses when every closed view holds a draft');
  await context.close();

  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('PASS registry cap UI');
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
