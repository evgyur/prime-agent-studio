// Isolated open/run UI: Ouvrir + Exécuter buttons and the run confirmation dialog.
// Never opens a real application or runs a real script: openFile/runFile are fakes.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'prime-open-run-ui-'));
const cwd = join(temp, 'Atelier'),
  agentHome = join(temp, 'agent'),
  sessionDir = join(temp, 'sessions');
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await mkdir('test-results', { recursive: true });
await mkdir('.local', { recursive: true });
const git = (...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true });
await git('init', '-q');
await git('config', 'user.name', 'Fixture');
await git('config', 'user.email', 'fixture@example.test');
await writeFile(join(cwd, 'task.ps1'), 'Write-Host bonjour\n');
await writeFile(join(cwd, 'notes.md'), '# Notes\n\nDu texte.\n');
await writeFile(join(cwd, 'settings.reg'), 'Windows Registry Editor Version 5.00\n');
await git('add', '.');
await git('commit', '-qm', 'Initial');
await writeFile(
  join(sessionDir, 'run-check.jsonl'),
  [
    { type: 'session', id: 'run-check', cwd, timestamp: '2026-10-20T00:00:00.000Z', version: 3 },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      message: { role: 'user', content: 'Vérifier les boutons Ouvrir et Exécuter' },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join('\n') + '\n',
);

const opened = [];
const ran = [];
const app = createApp({
  openFile: async (path) => {
    opened.push(path);
    return { opened: true };
  },
  runFile: async (path) => {
    ran.push(path);
    return { ran: true };
  },
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir: join(temp, 'data'),
  runtime: {
    async getStatus() {
      return { available: true, version: '0.9.8' };
    },
    async getModels() {
      return { models: [], default: {} };
    },
    async close() {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const errors = [];

try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  // Fixture-only: keep the classic inspector home, like test-inspector-ui.
  await context.addInitScript(() => {
    localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  await page.locator('#session-list .session-select').filter({ hasText: 'Vérifier les boutons' }).click();
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await page.getByRole('tab', { name: 'Fichiers', exact: true }).click();
  const viewer = page.locator('.inspector-viewer[data-inspector-unit="files"]');
  await page.getByRole('button', { name: 'Parcourir', exact: true }).click();

  // Runnable script: both buttons, then the confirmation dialog.
  await page.locator('[data-file-path="task.ps1"]').click();
  await expect(viewer).toBeVisible();
  const openButton = viewer.getByRole('button', { name: 'Ouvrir', exact: true });
  const runButton = viewer.getByRole('button', { name: 'Exécuter', exact: true });
  await expect(openButton).toBeVisible();
  await expect(runButton).toBeVisible();
  await page.screenshot({ path: '.local/open-run-preview.png', animations: 'disabled' });

  await runButton.click();
  const dialog = page.locator('.script-run-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('task.ps1');
  await expect(dialog).toContainText('avec vos droits Windows');
  const cancel = dialog.getByRole('button', { name: 'Annuler', exact: true });
  await expect(cancel).toBeFocused();
  await page.screenshot({ path: '.local/open-run-confirm.png', animations: 'disabled' });
  await cancel.click();
  await expect(dialog).not.toBeVisible();
  assert.deepEqual(ran, [], 'Cancel must not call the run route');

  await runButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Exécuter', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  assert.deepEqual(ran, [join(cwd, 'task.ps1')], 'Confirm calls the run route exactly once');
  await expect(viewer).toContainText('Exécution demandée sur le PC.');
  await page.keyboard.press('Escape');

  // Plain document: Ouvrir only.
  await page.locator('[data-file-path="notes.md"]').click();
  await expect(viewer.getByRole('button', { name: 'Ouvrir', exact: true })).toBeVisible();
  assert.equal(await viewer.getByRole('button', { name: 'Exécuter', exact: true }).count(), 0);
  await page.keyboard.press('Escape');

  // Registry data opens in Notepad but never runs.
  await page.locator('[data-file-path="settings.reg"]').click();
  await expect(viewer.getByRole('button', { name: 'Ouvrir', exact: true })).toBeVisible();
  assert.equal(await viewer.getByRole('button', { name: 'Exécuter', exact: true }).count(), 0);
  await page.keyboard.press('Escape');

  assert.deepEqual(opened, [], 'this script never triggers the open route');
  assert.deepEqual(ran, [join(cwd, 'task.ps1')]);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, buttons: true, dialog: true, once: ran.length === 1 }));
} finally {
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
