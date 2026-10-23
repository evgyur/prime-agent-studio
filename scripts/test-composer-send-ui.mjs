// Composer feedback while a message is handed to the server (slow run start).
// Regression: the text stayed editable during the latency, so an edit ended up
// both in the conversation and in the field. Isolated fixture, inert runtime.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const DELAY = 1500;
const temp = await mkdtemp(join(tmpdir(), 'prime-composer-send-'));
const cwd = join(temp, 'Atelier'),
  sessionDir = join(temp, 'sessions'),
  dataDir = join(temp, 'data'),
  agentHome = join(temp, 'agent');
for (const dir of [cwd, sessionDir, dataDir, agentHome]) await mkdir(dir, { recursive: true });
// Complete setup (provider, main and subagent models): sending is allowed.
await writeFile(
  join(dataDir, 'subagent-defaults.json'),
  JSON.stringify({
    version: 1,
    revision: 'fixture',
    global: { model: 'fixture/model', thinking: '' },
    projects: {},
  }),
);
let failNext = false;
const handles = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/model', name: 'Fixture', provider: 'fixture', reasoning: true }],
    configuredProviders: ['fixture'],
    default: { model: 'fixture/model', thinking: 'medium' },
  }),
  async start(input) {
    await new Promise((done) => setTimeout(done, DELAY));
    if (failNext) {
      failNext = false;
      throw new Error('Démarrage refusé par le test.');
    }
    const sessionId = input.sessionId || randomUUID();
    if (!input.sessionId) {
      await writeFile(
        join(sessionDir, `${sessionId}.jsonl`),
        [
          { type: 'session', id: sessionId, cwd, version: 3, timestamp: new Date().toISOString() },
          {
            type: 'message',
            id: `u-${sessionId}`,
            parentId: null,
            message: { role: 'user', content: input.message },
          },
        ]
          .map(JSON.stringify)
          .join('\n') + '\n',
      );
      setTimeout(() => input.onEvent({ kind: 'session', sessionId, cwd }), 100);
    }
    let settle;
    const done = new Promise((resolve) => (settle = resolve));
    handles.push(() => {
      input.onEvent({ kind: 'done', sessionId, status: 'completed', code: 0 });
      settle({ status: 'completed', code: 0 });
    });
    return { done, cancel: () => settle({ status: 'stopped', code: 0 }) };
  },
  async close() {},
};
const app = createApp({ runtime, agentHome, sessionDir, dataDir, initialCwd: cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
const field = 'textarea#composer:visible, .cv-composer-form textarea:visible';
try {
  for (const layout of ['classic', 'docked']) {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1400, height: 900 } });
    if (layout === 'classic')
      await context.addInitScript(() =>
        localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false })),
      );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator('#connection-label')).toContainText('connecté');
    await page.locator('#new-session').click();
    const input = page.locator(field).first();
    const form = page.locator('form.composer-form:visible').first();
    const status = page.locator('.run-status:visible').first();
    const userMessages = page.locator('.message.user:visible');

    // 1. Immediate lock: visible, read-only, announced; typing changes nothing.
    await input.fill(`Premier message ${layout}`);
    await input.press('Enter');
    await expect(form).toHaveClass(/is-sending/);
    await expect(form).toHaveAttribute('aria-busy', 'true');
    assert.equal(await input.evaluate((node) => node.readOnly), true);
    await expect(status).toContainText('Envoi du message');
    await input.focus();
    await page.keyboard.type(' modifié');
    await expect(input).toHaveValue(`Premier message ${layout}`);

    // 2. Accepted: empty, editable again, shown once in the conversation.
    await expect(input).toHaveValue('', { timeout: DELAY + 5000 });
    await expect(form).not.toHaveClass(/is-sending/);
    assert.equal(await input.evaluate((node) => node.readOnly), false);
    await expect(userMessages.filter({ hasText: `Premier message ${layout}` })).toHaveCount(1);
    await expect(userMessages.filter({ hasText: 'modifié' })).toHaveCount(0);
    handles.shift()();
    await expect(page.locator('.run-status:visible')).toHaveCount(0);

    // 3. Refused: the text comes back editable, nothing is added.
    failNext = true;
    await input.fill(`Message refusé ${layout}`);
    await input.press('Enter');
    await expect(form).toHaveClass(/is-sending/);
    await expect(form).not.toHaveClass(/is-sending/, { timeout: DELAY + 5000 });
    await expect(input).toHaveValue(`Message refusé ${layout}`);
    assert.equal(await input.evaluate((node) => node.readOnly), false);
    await expect(userMessages.filter({ hasText: `Message refusé ${layout}` })).toHaveCount(0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'Composer send passed (classic and docked): immediate read-only lock with status, no edit during the send, field emptied once accepted, text kept editable after a refusal.',
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
