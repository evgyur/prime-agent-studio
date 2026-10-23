// First-message setup: with no connected provider, a new conversation shows
// three steps (provider, main agent model, subagent model) and the first send
// waits until they are done. Isolated fixture: fake provider service and
// catalogue, real model defaults and subagent defaults stores, real UI.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const out = process.argv[2] || 'test-results';
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'prime-setup-gate-'));
const cwd = join(temp, 'Atelier'),
  sessionDir = join(temp, 'sessions'),
  dataDir = join(temp, 'data'),
  agentHome = join(temp, 'agent');
for (const dir of [cwd, sessionDir, dataDir, agentHome]) await mkdir(dir, { recursive: true });
// One existing conversation: it keeps the warning banner, never the steps.
await writeFile(
  join(sessionDir, 'existing.jsonl'),
  [
    { type: 'session', id: 'existing', cwd, version: 3, timestamp: '2026-10-22T09:00:00.000Z' },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      message: { role: 'user', content: 'Conversation existante' },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Réponse.' }],
        provider: 'anthropic',
        model: 'x',
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

let connected = false,
  url = '';
const starts = [];
const catalog = () => ({
  models: [
    {
      id: 'anthropic/claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      reasoning: true,
      thinkingLevels: ['low', 'medium', 'high'],
    },
    {
      id: 'anthropic/claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      provider: 'anthropic',
      reasoning: true,
      thinkingLevels: ['low', 'medium'],
    },
  ].filter(() => connected),
  configuredProviders: connected ? ['anthropic'] : [],
});
// Like the real provider service, a credential change invalidates the server
// model cache before the response returns.
async function refreshModels() {
  const response = await fetch(`${url}/api/models/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`Model refresh failed: ${response.status}`);
}
const providerEntry = () => ({
  id: 'anthropic',
  name: 'Anthropic',
  revision: connected ? 'r2' : 'r1',
  configured: connected,
  stored: connected,
  models: 2,
  methods: ['api_key'],
  credentialType: connected ? 'api_key' : undefined,
});
const app = createApp({
  agentHome,
  sessionDir,
  dataDir,
  initialCwd: cwd,
  providers: {
    list: async () => ({ providers: [providerEntry()], busy: false }),
    // Like the real provider service, a saved credential invalidates the
    // server model cache before the response returns.
    save: async () => {
      connected = true;
      await refreshModels();
      return { ok: true };
    },
    remove: async () => {
      connected = false;
      await refreshModels();
      return { ok: true };
    },
    login: () => ({}),
    job: () => ({}),
    cancel: () => ({}),
    respond: () => ({}),
    codexLink: async () => ({}),
    codexUsage: async () => ({}),
    close: async () => {},
  },
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    async getModels() {
      const settings = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8').catch(() => '{}'));
      const model =
        settings.defaultProvider && settings.defaultModel
          ? `${settings.defaultProvider}/${settings.defaultModel}`
          : null;
      return { ...catalog(), default: { model, thinking: 'medium' } };
    },
    async start(input) {
      starts.push(input);
      throw new Error('inert fixture');
    },
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
try {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() =>
    localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false })),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté');
  const gate = page.locator('#welcome .setup-gate');
  const step = (id) => gate.locator(`[data-setup-step="${id}"]`);
  await expect(gate).toBeVisible();
  await expect(page.locator('#welcome .starter-grid')).toBeHidden();
  await expect(page.locator('#configuration-warning')).toBeHidden();
  await expect(step('provider')).toHaveAttribute('data-state', 'current');
  await expect(step('main')).toHaveAttribute('data-state', 'pending');
  await expect(step('main').locator('[data-setup-action]')).toBeDisabled();
  await expect(page.locator('#composer')).toHaveAttribute('placeholder', /Terminez la configuration/);
  await page.locator('#composer').fill('Bonjour');
  await expect(page.locator('#send-button')).toBeDisabled();
  await page.locator('#composer').press('Enter');
  await page.screenshot({ path: join(out, 'setup-gate-1-provider.png') });

  // 1. Connect a provider through the real Providers dialog.
  await step('provider').locator('[data-setup-action="provider"]').click();
  await expect(page.locator('#providers-dialog')).toBeVisible();
  await page
    .locator('.provider-card[data-provider="anthropic"]')
    .getByRole('button', { name: 'Ajouter une clé API' })
    .click();
  await page.locator('#providers-dialog form input[type="password"]').fill('sk-test');
  await page.locator('#providers-dialog form [type="submit"]').click();
  await expect(page.locator('.provider-card[data-provider="anthropic"]')).toContainText('Configuré');
  await page.keyboard.press('Escape');
  await expect(step('provider')).toHaveAttribute('data-state', 'done');
  await expect(step('provider')).toContainText('Connecté : anthropic');
  await expect(step('main')).toHaveAttribute('data-state', 'current');
  await page.screenshot({ path: join(out, 'setup-gate-2-main.png') });

  // 2. Main agent model: the picker offers only real models (no automatic choice).
  await step('main').locator('[data-setup-action="main"]').click();
  await expect(page.locator('#model-dialog')).toBeVisible();
  await expect(page.locator('#model-list .model-row[data-model-id=""]')).toHaveCount(0);
  await page
    .locator('#model-list .model-row[data-model-id="anthropic/claude-sonnet-4-6"] .model-choice')
    .click();
  await expect(step('main')).toHaveAttribute('data-state', 'done');
  await expect(step('main')).toContainText('Claude Sonnet 4.6');
  await expect(step('subagent')).toHaveAttribute('data-state', 'current');
  const settings = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(`${settings.defaultProvider}/${settings.defaultModel}`, 'anthropic/claude-sonnet-4-6');
  await page.screenshot({ path: join(out, 'setup-gate-3-subagent.png') });

  // 3. Subagents: one click reuses the main model.
  await step('subagent').locator('[data-setup-action="subagent-same"]').click();
  await expect(gate).toBeHidden();
  await expect(page.locator('#welcome .starter-grid')).toBeVisible();
  const policy = JSON.parse(await readFile(join(dataDir, 'subagent-defaults.json'), 'utf8'));
  assert.equal(policy.global.model, 'anthropic/claude-sonnet-4-6');
  await expect(page.locator('#composer')).not.toHaveAttribute('placeholder', /Terminez la configuration/);
  await expect(page.locator('#send-button')).toBeEnabled();
  assert.equal(starts.length, 0, 'nothing was sent while the setup was incomplete');
  await page.screenshot({ path: join(out, 'setup-gate-4-done.png') });

  // Disconnecting the provider brings the steps back (model now unusable).
  await page.evaluate(() =>
    fetch('/api/providers/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    }),
  );
  await page.reload();
  await expect(gate).toBeVisible();
  await expect(step('provider')).toHaveAttribute('data-state', 'current');
  // An existing conversation keeps its history and shows the banner instead.
  await page.locator('#session-list').getByText('Conversation existante', { exact: true }).click();
  await expect(page.locator('#messages')).toContainText('Réponse.');
  await expect(gate).toBeHidden();
  await expect(page.locator('#configuration-warning')).toBeVisible();
  assert.deepEqual(errors, []);
  await context.close();

  // Default modular layout and phone width: the steps show in the pane.
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    const docked = await browser.newContext({ locale: 'fr-FR', viewport, hasTouch: viewport.width < 600 });
    const pane = await docked.newPage();
    pane.on('pageerror', (error) => errors.push(error.message));
    await pane.goto(url);
    await expect(pane.locator('#connection-label')).toContainText('connecté');
    if (viewport.width < 600)
      await pane
        .locator('#new-session')
        .click({ force: true })
        .catch(() => {});
    const visibleGate = pane.locator('.setup-gate:visible');
    await expect(visibleGate).toHaveCount(1);
    await expect(visibleGate.locator('[aria-current="step"]')).toHaveAttribute('data-setup-step', 'provider');
    const field = pane.locator('textarea#composer:visible, .cv-composer-form textarea:visible').first();
    await field.fill('Bonjour');
    await expect(
      pane
        .locator(
          'form.composer-form:visible button[type="submit"]:visible, form.composer-form:visible [data-cvw="send"]:visible',
        )
        .first(),
    ).toBeDisabled();
    await pane.screenshot({ path: join(out, `setup-gate-docked-${viewport.width}.png`) });
    await docked.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'Setup gate passed: three steps in order, first send blocked, real Providers dialog, picker without automatic choice, settings written, gate hidden once complete and back after disconnection, banner kept in existing conversations, modular layout and phone width.',
  );
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
