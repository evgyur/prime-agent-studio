// Real-app, isolated resilient-bootstrap smoke: the conversation list must
// render while engine --version and the model catalog hang, then models and
// pickers hydrate once the runtime answers. No live agent, no model turn.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const temp = await mkdtemp(join(tmpdir(), 'studio-bootstrap-resilient-'));
const cwd = join(temp, 'BootstrapFixture'),
  sessionDir = join(temp, 'sessions');
await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
await writeFile(
  join(sessionDir, 'seed-session.jsonl'),
  [
    { type: 'session', id: 'seed-session', cwd, timestamp: '2026-10-01T12:00:00.000Z' },
    {
      type: 'message',
      id: 'seed-1',
      parentId: null,
      message: { role: 'user', content: 'Seed conversation' },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n') + '\n',
);

const calls = { status: 0, models: 0, starts: 0 };
let releaseVersion, releaseModels;
const pendingVersion = new Promise((resolve) => {
  releaseVersion = resolve;
});
const pendingModels = new Promise((resolve) => {
  releaseModels = resolve;
});
function releaseRuntime() {
  releaseVersion({ available: true, version: 'fixture', nodeVersion: '9.9.9' });
  releaseModels({
    models: [{ id: 'fixture/model', name: 'Fixture', provider: 'fixture' }],
    default: { model: 'fixture/model' },
  });
}
const app = createApp({
  initialCwd: cwd,
  sessionDir,
  dataDir: join(temp, 'data'),
  agentHome: join(temp, 'agent'),
  commands: { list: async () => ({ commands: [] }) },
  runtime: {
    getStatus: () => {
      calls.status += 1;
      return pendingVersion;
    },
    getModels: () => {
      calls.models += 1;
      return pendingModels;
    },
    start: async () => {
      calls.starts += 1;
      throw Error('No model turn allowed in bootstrap smoke');
    },
    close: async () => {},
  },
});

let browser;
const errors = [];
const seen = { light: 0, version: 0, models: 0 };
const check = (name) => console.log('PASS', name);
try {
  await app.store.project({ cwd });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await launchStudioBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  // The first light bootstrap attempt stalls past the client timeout: the
  // app must retry on its bounded timeout and recover without a relaunch.
  // (Holding beats aborting here: abort loses the race against the instant
  // local server, while a hold deterministically trips the 8s timeout.)
  let heldFirstLight = false;
  await context.route('**/*', async (route) => {
    const target = route.request().url();
    if (!target.startsWith(url)) return route.abort();
    const parsed = new URL(target);
    if (parsed.pathname === '/api/bootstrap' && parsed.searchParams.get('light') === '1' && !heldFirstLight) {
      heldFirstLight = true;
      await new Promise((done) => setTimeout(done, 10000));
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (req) => {
    const parsed = new URL(req.url());
    if (parsed.origin !== url) return;
    if (parsed.pathname === '/api/bootstrap' && parsed.searchParams.get('light') === '1') seen.light += 1;
    if (parsed.pathname === '/api/version') seen.version += 1;
    if (parsed.pathname === '/api/models') seen.models += 1;
  });
  await page.goto(url);
  // The seeded conversation row renders without waiting for runtime warmup,
  // even though the first light attempt stalled past the client timeout.
  await expect(page.locator('[data-session-id="seed-session"]')).toBeVisible({ timeout: 25000 });
  check('conversation list renders while runtime status/models hang (retry recovered)');
  assert.ok(seen.light >= 2, `expected a retried light bootstrap, saw ${seen.light}`);
  // Background hydration may already call models; the light route is isolated in API tests.
  await expect(page.locator('#connection-label')).toHaveText('Engine connected', { timeout: 20000 });
  check('connection shows engine state instead of a stuck static label');
  await mkdir('.local/study/startup-shots', { recursive: true });
  await page.screenshot({ path: '.local/study/startup-shots/conversations-before-models.png' });
  // Hydration runs in the background; unblock the runtime and the pickers
  // must fill in without any app relaunch.
  releaseModels({
    models: [{ id: 'fixture/model', name: 'Fixture', provider: 'fixture' }],
    default: { model: 'fixture/model' },
  });
  await expect(page.locator('#model-select option')).not.toHaveCount(1, { timeout: 20000 });
  check('model picker hydrates even while the version is still pending');
  releaseVersion({ available: true, version: 'fixture', nodeVersion: '9.9.9' });
  assert.equal(calls.starts, 0, 'no live agent run was ever started');
  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
} finally {
  releaseRuntime();
  await browser?.close();
  app.server.closeAllConnections();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
console.log('bootstrap resilient UI smoke passed');
