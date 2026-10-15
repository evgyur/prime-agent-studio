// A docked secondary pane shows the same "Latest messages" pill as the host:
// icon and label, centered just above its composer, and it scrolls down.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const temp = await mkdtemp(join(tmpdir(), 'prime-pane-pill-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
for (const dir of [cwd, sessionDir, join(temp, 'data'), join(temp, 'agent')])
  await mkdir(dir, { recursive: true });
async function seed(id, title, count, minute) {
  const at = Date.UTC(2026, 9, 1, 10, minute);
  const records = [{ type: 'session', id, cwd, version: 3, timestamp: new Date(at).toISOString() }];
  let parent = null;
  for (let i = 0; i < count; i += 1) {
    const user = {
      type: 'message',
      id: `${id}-u${i}`,
      parentId: parent,
      message: { role: 'user', content: i ? `Suite ${i}` : title, timestamp: at + i * 2000 },
    };
    const text =
      `Réponse ${i + 1}. ` + 'Paragraphe de remplissage pour faire défiler la conversation. '.repeat(8);
    const reply = {
      type: 'message',
      id: `${id}-a${i}`,
      parentId: user.id,
      message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: at + i * 2000 + 1000 },
    };
    records.push(user, reply);
    parent = reply.id;
  }
  await writeFile(join(sessionDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
await seed('short', 'Courte conversation', 1, 0);
await seed('long', 'Longue conversation', 30, 1);
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/m', name: 'Fixture', provider: 'fixture' }],
    default: { model: 'fixture/m' },
  }),
  async start() {
    throw new Error('No run expected');
  },
  async close() {},
};
const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir: join(temp, 'data'),
  initialCwd: cwd,
});
await app.store.project({ cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
const errors = [];
try {
  for (const [locale, label] of [
    ['fr-FR', 'Derniers messages'],
    ['en-US', 'Latest messages'],
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale,
      reducedMotion: 'reduce',
    });
    await context.addInitScript(
      ({ cwd, layout }) => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem(
          'prime-studio.selection',
          JSON.stringify({ cwd, sessionId: 'short', projectOverview: false }),
        );
        localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
      },
      { cwd, layout: { ...createDefaultLayout(), enabled: true } },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(String(error?.message || error)));
    await page.goto(url);
    await expect(page.locator('#dock-workspace')).toBeVisible({ timeout: 20000 });
    // The long conversation opens in a new secondary tab.
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Longue conversation' })
      .first()
      .click();
    const id = await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('.dock-tab.is-conversation.is-focused')?.dataset.dockTab),
      )
      .not.toBe('conversation')
      .then(() =>
        page.evaluate(() => document.querySelector('.dock-tab.is-conversation.is-focused').dataset.dockTab),
      );
    const shell = page.locator(`.cvw-shell[data-view="${id}"]`);
    const scroller = shell.locator('.cvw-scroller');
    const pill = shell.locator('.cvw-pill');
    await expect(shell.locator('.cvw-messages')).toContainText('Réponse 30');
    await expect(pill).toBeHidden();
    await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(label);
    await expect(pill.locator('svg')).toHaveCount(1);
    assert.ok((await pill.getAttribute('aria-label'))?.length > 5, 'accessible name');
    const [p, s, composer] = await Promise.all([
      pill.boundingBox(),
      scroller.boundingBox(),
      shell.locator('.cvw-composer-area').boundingBox(),
    ]);
    assert.ok(p.y + p.height <= composer.y, 'above the composer');
    assert.ok(p.y + p.height <= s.y + s.height, 'inside the conversation area');
    assert.ok(Math.abs(p.x + p.width / 2 - (s.x + s.width / 2)) < 2, 'horizontally centered');
    if (locale === 'fr-FR')
      await page.screenshot({
        path: 'test-results/pane-scroll-pill.png',
        clip: { x: s.x, y: s.y + s.height - 220, width: s.width, height: 220 + composer.height + 30 },
      });
    await pill.click();
    await expect(pill).toBeHidden();
    assert.ok(
      await scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 3),
      'back at the bottom',
    );
    console.log(`ok - ${locale} pane pill`);
    await context.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('PASS pane scroll pill');
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
