// Sidebar navigation in the docked workspace never replaces a conversation
// that is in the layout: a mounted target is focused, anything else opens a
// new tab right after the active conversation. Fixture server, stub runtime.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const temp = await mkdtemp(join(tmpdir(), 'prime-sidebar-select-'));
const cwdA = join(temp, 'Atelier');
const cwdB = join(temp, 'Vtrott');
const sessionDir = join(temp, 'sessions');
for (const dir of [cwdA, cwdB, sessionDir, join(temp, 'data'), join(temp, 'agent')])
  await mkdir(dir, { recursive: true });
const TITLES = { alpha: 'Alpha calibrer', beta: 'Beta distribuer', gamma: 'Gamma verifier' };
for (let i = 1; i <= 6; i += 1) TITLES[`extra${i}`] = `Extra numero ${i}`;
let minute = 0;
for (const [id, title] of Object.entries(TITLES)) {
  const at = new Date(Date.UTC(2026, 9, 1, 10, minute++)).toISOString();
  const records = [
    { type: 'session', id, cwd: cwdA, version: 3, timestamp: at },
    {
      type: 'message',
      id: `${id}-u`,
      parentId: null,
      message: { role: 'user', content: title, timestamp: Date.parse(at) },
    },
    {
      type: 'message',
      id: `${id}-a`,
      parentId: `${id}-u`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Réponse ${title}` }],
        timestamp: Date.parse(at) + 1000,
      },
    },
  ];
  await writeFile(join(sessionDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const starts = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/m', name: 'Fixture', provider: 'fixture' }],
    default: { model: 'fixture/m' },
  }),
  async start(input) {
    starts.push(input.sessionId || null);
    throw new Error('No run expected');
  },
  async close() {},
};
const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir: join(temp, 'data'),
  initialCwd: cwdA,
});
await app.store.project({ cwd: cwdA });
await app.store.project({ cwd: cwdB });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

const browser = await launchStudioBrowser();
const errors = [];
async function open(enabled) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: 'fr-FR',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(
    ({ cwd, layout }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'alpha', projectOverview: false }),
      );
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
    },
    { cwd: cwdA, layout: { ...createDefaultLayout(), enabled } },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(String(error?.message || error)));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 20000 });
  return { context, page };
}
// Conversation tabs per group, in DOM order, plus each view's binding.
const snap = (page) =>
  page.evaluate(() => {
    const sidecar = JSON.parse(
      localStorage.getItem('prime-studio.docking.conversations') || '{"entries":[]}',
    );
    const bound = Object.fromEntries(
      sidecar.entries.map((e) => [e.id, e.sessionId || (e.viewRunId ? 'run' : `new:${e.projectCwd}`)]),
    );
    return {
      groups: [...document.querySelectorAll('[data-dock-group]')]
        .map((group) =>
          [...group.querySelectorAll('button[data-dock-tab]')]
            .map((tab) => tab.dataset.dockTab)
            .filter((id) => id === 'conversation' || id.startsWith('conv:')),
        )
        .filter((ids) => ids.length),
      bound,
      focused: document.querySelector('.dock-tab.is-conversation.is-focused')?.dataset.dockTab ?? null,
    };
  });
const sessionsIn = (s) => s.groups.flat().map((id) => s.bound[id]);
async function clickSession(page, id) {
  const row = page.locator('#session-list .session-select').filter({ hasText: TITLES[id] }).first();
  // The project list shows a few rows first: expand it when needed.
  for (let i = 0; i < 3 && !(await row.isVisible()); i += 1) {
    const more = page.locator('#session-list button').filter({ hasText: 'Afficher plus' }).first();
    if (!(await more.isVisible())) break;
    await more.click();
  }
  await row.click();
}

try {
  const { context, page } = await open(true);
  await expect(page.locator('#dock-workspace')).toBeVisible();
  await expect.poll(async () => (await snap(page)).bound.conversation).toBe('alpha');

  // 1. A conversation without a tab opens a new tab after the active one; Alpha stays.
  await clickSession(page, 'beta');
  await expect.poll(async () => sessionsIn(await snap(page))).toEqual(['alpha', 'beta']);
  let s = await snap(page);
  const betaTab = s.groups[0][1];
  assert.equal(s.bound.conversation, 'alpha', 'Alpha is never replaced');
  assert.equal(s.focused, betaTab);
  await expect
    .poll(() => page.evaluate(() => document.body.innerText.includes('Réponse Beta distribuer')))
    .toBe(true);

  // 2. Already in the layout: focused, never duplicated.
  await clickSession(page, 'beta');
  await clickSession(page, 'alpha');
  await expect.poll(async () => (await snap(page)).focused).toBe('conversation');
  assert.deepEqual(sessionsIn(await snap(page)), ['alpha', 'beta']);

  // 3. Inserted right after the active conversation, not appended.
  await clickSession(page, 'gamma');
  await expect.poll(async () => sessionsIn(await snap(page))).toEqual(['alpha', 'gamma', 'beta']);

  // 4. A closed conversation reopens next to the active one, once.
  await page.locator(`button[data-dock-tab="${betaTab}"]`).click({ button: 'middle' });
  await expect.poll(async () => sessionsIn(await snap(page))).toEqual(['alpha', 'gamma']);
  await clickSession(page, 'alpha');
  await clickSession(page, 'beta');
  await expect.poll(async () => sessionsIn(await snap(page))).toEqual(['alpha', 'beta', 'gamma']);
  s = await snap(page);
  assert.equal(sessionsIn(s).filter((id) => id === 'beta').length, 1, 'one Beta tab');

  // 5. Project name: the overview opens in its own tab; a second click reuses it.
  await page.locator('.project-row').filter({ hasText: 'Vtrott' }).click();
  await expect
    .poll(async () => sessionsIn(await snap(page)))
    .toEqual(['alpha', 'beta', `new:${cwdB}`, 'gamma']);
  await page.locator('.project-row').filter({ hasText: 'Vtrott' }).click();
  assert.equal((await snap(page)).groups.flat().length, 4, 'no second overview tab');
  await page.locator('.project-row').filter({ hasText: 'Atelier' }).click();
  s = await snap(page);
  assert.equal(s.groups.flat().length, 5);
  assert.deepEqual(
    ['alpha', 'beta', 'gamma'].map((id) => sessionsIn(s).includes(id)),
    [true, true, true],
    'conversations kept',
  );

  // 6. Eight-tab limit: refused with a message, nothing replaced.
  for (const id of ['extra1', 'extra2', 'extra3']) await clickSession(page, id);
  await expect.poll(async () => (await snap(page)).groups.flat().length).toBe(8);
  const full = await snap(page);
  await clickSession(page, 'extra4');
  await expect(page.locator('.toast.error')).toContainText('Fermez un onglet');
  assert.deepEqual(await snap(page), full, 'layout, bindings and focus unchanged');
  await clickSession(page, 'alpha');
  await expect
    .poll(async () => {
      const now = await snap(page);
      return now.bound[now.focused];
    })
    .toBe('alpha');
  await page.screenshot({ path: 'test-results/sidebar-selection-docked.png' });
  console.log('ok - docked sidebar navigation never replaces a conversation');
  await context.close();

  // 7. Classic layout keeps its single editor.
  const classic = await open(false);
  await expect(classic.page.locator('#dock-workspace')).toBeHidden();
  await clickSession(classic.page, 'beta');
  await expect.poll(async () => (await snap(classic.page)).bound.conversation).toBe('beta');
  console.log('ok - classic layout unchanged');
  await classic.context.close();

  assert.deepEqual(starts, [], 'no run started');
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('PASS sidebar conversation selection');
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
