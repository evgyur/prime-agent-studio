// Isolated browser fixture: message file links stay clickable (dot folders,
// binaries, spaces, encoded, folders), the viewer shows binary file info with
// "Ouvrir" (refused for executables) plus "Ouvrir le dossier" (reveal), and
// links expose a context menu. OS folder launches are recorded, never opened.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-file-links-ui-'));
const cwd = join(temp, 'Atelier');
const externalDir = join(temp, 'External folder');
const externalFile = join(externalDir, 'outside notes.md');
const agentHome = join(temp, 'agent');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await Promise.all([cwd, agentHome, sessionDir, dataDir].map((path) => mkdir(path, { recursive: true })));
await mkdir(externalDir, { recursive: true });
await writeFile(externalFile, '# External private content\n');
await mkdir(join(cwd, 'docs'), { recursive: true });
await mkdir(join(cwd, 'builds'), { recursive: true });
const setupDir = join(cwd, '.local', 'desktop-release', 'v4.0.2');
await mkdir(setupDir, { recursive: true });
await writeFile(
  join(cwd, 'docs', 'guide.md'),
  '# Guide\n\nContenu du guide. [Dossier externe relatif](../../External%20folder/).\n',
);
await writeFile(join(cwd, 'docs', 'mes notes.md'), '# Notes\n');
await writeFile(join(cwd, 'builds', 'app.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0xff]));
await writeFile(
  join(setupDir, 'Prime-Agent-Studio_4.0.2_x64-setup.exe'),
  Buffer.from([0x4d, 0x5a, 0x00, 0xff]),
);
await promisify(execFile)('git', ['-C', cwd, 'init', '-q']);
const setupReference = '.local/desktop-release/v4.0.2/Prime-Agent-Studio_4.0.2_x64-setup.exe';
const timestamp = new Date().toISOString();
await writeFile(
  join(sessionDir, 'file-links.jsonl'),
  [
    { type: 'session', id: 'file-links', version: 3, cwd, timestamp },
    {
      type: 'message',
      id: 'user-links',
      timestamp,
      message: { role: 'user', content: 'Montrer les fichiers du projet.' },
    },
    {
      type: 'message',
      id: 'agent-links',
      parentId: 'user-links',
      timestamp,
      message: {
        role: 'assistant',
        model: 'test/model',
        content: [
          {
            type: 'text',
            text: `Voici les fichiers : [Guide](docs/guide.md), [Installeur](builds/app.exe), [Dossier docs](docs/), [Notes espace](docs/mes%20notes.md), [Setup 4.0.2](${setupReference}), [Git](.git/config), [Racine](${pathToFileURL(cwd).href}), [Dossier externe](<${externalDir.replaceAll('\\', '/')}>), [Fichier externe](<${externalFile.replaceAll('\\', '/')}>), [URL externe](${pathToFileURL(externalFile).href}).`,
          },
        ],
        stopReason: 'stop',
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
const opened = [];
const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir,
  openDirectory: async (path) => {
    opened.push(path);
    return { opened: true };
  },
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [{ id: 'test/model', name: 'Test Model', provider: 'test' }],
      default: { model: 'test/model', thinking: 'medium' },
    }),
    start: async () => {
      throw new Error('This visual fixture never starts an agent');
    },
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser = await launchStudioBrowser({
    headless: true,
    ...(process.env.PRIME_STUDIO_TEST_BROWSER ? { channel: process.env.PRIME_STUDIO_TEST_BROWSER } : {}),
  });
  await mkdir(resolve('test-results/file-links'), { recursive: true });
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1440, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  const fileRequests = [];
  page.on('request', (request) => {
    if (/\/api\/(?:project-files\/resolve|projects\/open)(?:\?|$)/.test(request.url()))
      fileRequests.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('#session-list').getByText('Montrer les fichiers du projet.', { exact: true }).click();
  const message = page.locator('.message.assistant').first();
  await expect(message).toBeVisible();
  const links = message.locator('a.document-link');
  await expect(links).toHaveText([
    'Guide',
    'Installeur',
    'Dossier docs',
    'Notes espace',
    'Setup 4.0.2',
    'Git',
    'Racine',
    'Dossier externe',
    'Fichier externe',
    'URL externe',
  ]);
  const menu = page.locator('.file-link-menu');
  const viewer = page.locator('.inspector-viewer[open]');
  const setup = links.filter({ hasText: 'Setup 4.0.2' });

  // The exact .local installer case: clickable, binary info, reveal works,
  // explicit open stays refused without launching anything.
  await setup.click();
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.inspector-view-body')).toContainText('indisponible');
  await expect(viewer.getByRole('button', { name: 'Ouvrir', exact: true })).toBeVisible();
  const viewerFolder = viewer.getByRole('button', { name: 'Ouvrir le dossier', exact: true });
  await expect(viewerFolder).toBeVisible();
  await viewer.getByRole('button', { name: 'Ouvrir', exact: true }).click();
  await expect(viewer.locator('.inspector-open-feedback')).toContainText('ne peut pas');
  assert.deepEqual(opened, []);
  await viewerFolder.click();
  await expect.poll(() => opened.length).toBe(1);
  assert.equal(opened.pop(), await realpath(setupDir));
  await expect(viewer.locator('.inspector-open-feedback')).toContainText('demandée');
  await page.screenshot({ path: resolve('test-results/file-links/viewer-exe.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');

  // Folder links open the viewer as a folder with a reveal action only:
  // the file open action stays hidden because the file endpoint rejects folders.
  await links.filter({ hasText: 'Dossier docs' }).click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Ouvrir', exact: true })).toHaveCount(0);
  await expect(viewer.locator('.inspector-view-body')).toContainText('docs');
  await viewer.getByRole('button', { name: 'Ouvrir le dossier', exact: true }).click();
  await expect.poll(() => opened.length).toBe(1);
  assert.equal(opened.pop(), await realpath(join(cwd, 'docs')));
  await page.keyboard.press('Escape');

  // A project root reference opens the viewer as a folder with reveal only.
  await links.filter({ hasText: 'Racine' }).click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Ouvrir', exact: true })).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Ouvrir le dossier', exact: true }).click();
  await expect.poll(() => opened.length).toBe(1);
  assert.equal(opened.pop(), await realpath(cwd));
  await page.keyboard.press('Escape');

  // Version control internals stay refused, but the link is still clickable.
  await links.filter({ hasText: 'Git' }).click();
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.inspector-view-body')).toContainText('pas accessible');
  await page.screenshot({
    path: resolve('test-results/file-links/viewer-refused.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');

  // Right click menu offers open, reveal and copy actions on the .local file.
  await setup.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Ouvrir', 'Ouvrir le dossier', 'Copier le chemin']);
  await page.screenshot({ path: resolve('test-results/file-links/menu.png'), animations: 'disabled' });
  await menu.getByRole('menuitem', { name: 'Copier le chemin', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10000 })
    .toBe(join(cwd, '.local', 'desktop-release', 'v4.0.2', 'Prime-Agent-Studio_4.0.2_x64-setup.exe'));
  await setup.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Ouvrir le dossier', exact: true }).click();
  await expect.poll(() => opened.length).toBe(1);
  assert.equal(opened.pop(), await realpath(setupDir));

  // Native reveal is independent of project preview access. It sends the
  // original reference straight to the native endpoint, with no resolve GET.
  for (const [label, reference] of [
    ['Dossier externe', externalDir.replaceAll('\\', '/')],
    ['Fichier externe', externalFile.replaceAll('\\', '/')],
    ['URL externe', pathToFileURL(externalFile).href],
  ]) {
    fileRequests.length = 0;
    await links.filter({ hasText: label }).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Ouvrir le dossier', exact: true }).click();
    await expect.poll(() => opened.length).toBe(1);
    assert.equal(opened.pop(), await realpath(externalDir));
    assert.equal(fileRequests.length, 1, JSON.stringify(fileRequests));
    assert.equal(fileRequests[0].method, 'POST');
    assert.deepEqual(fileRequests[0].body, { cwd, reference, basePath: '' });
  }
  await links.filter({ hasText: 'Fichier externe' }).click();
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.inspector-view-body')).toContainText('ne se trouve pas dans le projet');
  await expect(viewer.locator('.inspector-view-body')).not.toContainText('External private content');
  assert.deepEqual(opened, []);
  await page.keyboard.press('Escape');

  // Relative links in a rendered document use its own basePath, not whichever
  // project or document becomes active later.
  await links.filter({ hasText: 'Guide' }).click();
  const nestedLink = viewer.getByRole('link', { name: 'Dossier externe relatif', exact: true });
  await expect(nestedLink).toBeVisible();
  fileRequests.length = 0;
  await nestedLink.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Ouvrir le dossier', exact: true }).click();
  await expect.poll(() => opened.length).toBe(1);
  assert.equal(opened.pop(), await realpath(externalDir));
  assert.equal(fileRequests.length, 1, JSON.stringify(fileRequests));
  assert.deepEqual(fileRequests[0].body, {
    cwd,
    reference: '../../External%20folder/',
    basePath: 'docs/guide.md',
  });
  await viewer.evaluate((dialog) => {
    window.fileLinksDialogClosed = new Promise((done) =>
      dialog.addEventListener('close', () => done(), { once: true }),
    );
  });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.fileLinksDialogClosed);

  // Wait for the dialog close event to restore its opener before testing a
  // different link's keyboard focus.
  await expect(links.filter({ hasText: 'Guide' })).toBeFocused();

  // Keyboard menu access restores focus on close.
  await setup.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(setup).toBeFocused();

  // The reveal menu stays inside a phone viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await setup.click({ button: 'right' });
  const box = await menu.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  assert.ok(box.y + box.height <= 844, JSON.stringify(box));
  await page.keyboard.press('Escape');
  // Exercise menu gates and one-time context capture without launching an OS
  // app. The integration cases above cover the real app callback and server.
  const gates = await page.evaluate(async () => {
    const { bindFileLinks } = await import('/public/file-links.js');
    const root = document.createElement('div');
    root.innerHTML = '<a href="file:///outside/a%20file.md">fixture</a>';
    document.body.append(root);
    let context = { cwd: '', basePath: 'docs/guide.md', online: true, nativeFileOpen: true, readOnly: false };
    let contextReads = 0;
    const revealed = [];
    bindFileLinks(root, [], () => {}, {
      context: () => {
        contextReads++;
        return { ...context };
      },
      resolve: () => {
        throw new Error('Reveal must not resolve project content');
      },
      reveal: async (reference, snapshot) => {
        revealed.push({ reference, context: snapshot });
      },
      toast: () => {},
    });
    const anchor = root.querySelector('a');
    const open = () => {
      anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return document.querySelector('.file-link-menu button:nth-child(2)');
    };
    const disabled = [];
    for (const patch of [{ readOnly: true }, { nativeFileOpen: false }, { online: false }]) {
      const saved = context;
      context = { ...saved, ...patch };
      disabled.push(open().disabled);
      context = saved;
    }
    const button = open();
    const enabledWithoutCwd = !button.disabled;
    const readsBeforeClick = contextReads;
    context = { ...context, cwd: '/changed', basePath: 'changed.md' };
    button.click();
    await Promise.resolve();
    root.remove();
    return { disabled, enabledWithoutCwd, readsDuringClick: contextReads - readsBeforeClick, revealed };
  });
  assert.deepEqual(gates.disabled, [true, true, true]);
  assert.equal(gates.enabledWithoutCwd, true);
  assert.equal(gates.readsDuringClick, 0);
  assert.deepEqual(gates.revealed, [
    {
      reference: 'file:///outside/a%20file.md',
      context: { cwd: '', basePath: 'docs/guide.md', online: true, nativeFileOpen: true, readOnly: false },
    },
  ]);
  assert.deepEqual(errors, []);
  console.log(
    'File links PASS: native external folder/file/URL reveal, nested paths, sandboxed preview, permission gates, keyboard, mobile',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5 });
}
