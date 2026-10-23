// Conversation menu: no header "⋯" button; the menu opens from the sidebar row
// (right-click or its ⋯ button) on desktop and touch. The dot icons must render
// visible pixels at high pixel densities. Isolated fixture, inert runtime.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-conversation-menu-'));
const cwd = join(temp, 'Atelier'),
  sessionDir = join(temp, 'sessions'),
  dataDir = join(temp, 'data'),
  agentHome = join(temp, 'agent');
for (const dir of [cwd, sessionDir, dataDir, agentHome]) await mkdir(dir, { recursive: true });
const title = 'Conversation du menu';
await writeFile(
  join(sessionDir, 'menu.jsonl'),
  [
    { type: 'session', id: 'menu-session', cwd, version: 3, timestamp: '2026-10-22T09:00:00.000Z' },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: title } },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Réponse.' }],
        model: 'm',
        provider: 'fixture',
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
const app = createApp({
  agentHome,
  sessionDir,
  dataDir,
  initialCwd: cwd,
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    start: async () => {
      throw new Error('inert fixture');
    },
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
// Bright pixels of a rendered icon: near-zero-length strokes used to vanish.
async function inkOf(page, locator) {
  const png = await locator.screenshot();
  return page.evaluate(async (b64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = Object.assign(document.createElement('canvas'), {
      width: image.width,
      height: image.height,
    });
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) > 110) ink++;
    return ink;
  }, png.toString('base64'));
}
try {
  for (const device of [
    { name: 'desktop', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 3 },
    {
      name: 'mobile',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  ]) {
    const context = await browser.newContext({ locale: 'fr-FR', ...device });
    await context.addInitScript(() =>
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false })),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator('#connection-label')).toContainText('connecté');
    assert.equal(await page.locator('#session-menu-button').count(), 0, 'no header menu button');
    if (device.isMobile) await page.locator('#toggle-sidebar').click();
    const row = page.locator('#session-list .session-row').filter({ hasText: title });
    await expect(row).toHaveCount(1);
    const more = row.locator('.session-more');
    if (device.isMobile) {
      await expect(more).toBeVisible();
      await more.tap();
    } else {
      await row.click({ button: 'right' });
      await expect(page.locator('#session-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5);
      await row.hover();
      await expect(more).toBeVisible();
      await more.click();
    }
    await expect(page.locator('#session-menu')).toBeVisible();
    await expect(page.locator('#session-menu [data-action="rename"]')).toBeVisible();
    const ink = await inkOf(page, more.locator('svg'));
    assert.ok(ink >= 60, `${device.name}: ⋯ icon renders visible dots at 3x (${ink} px)`);
    await page.screenshot({ path: `test-results/conversation-menu-${device.name}.png` });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'Conversation menu passed (desktop and touch, 3x density): no header button, sidebar row menu by right-click and ⋯, visible dot icon.',
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
