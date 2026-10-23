// Isolated browser fixture: highlight.js powers file previews and
// conversation code blocks locally (no CDN), with plain-text fallbacks.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const temp = await mkdtemp(join(tmpdir(), 'prime-code-highlight-ui-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
const sessionId = 'code-highlight-fixture';
await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);

const jsSource = `// list active users
const users = await db.query('SELECT * FROM users');
export function count(users) {
  return users.length;
}
`;
const pySource = `def greet(name):
    return f"hello {name}"

print(greet("world"))
`;
const htmlSource = `<!DOCTYPE html>
<html>
  <body>
    <h1>Title</h1>
  </body>
</html>
`;
const evilSource = `<div>
  <script>window.__evil_executed = true;</script>
</div>
`;
// Too many lines for highlighting (6000 > 5000), but small enough for the
// file preview endpoint (its own 512 KB cap): the UI must keep plain text.
const hugeSource = `// generated file: too many lines to highlight
${'const value = 123456789;\n'.repeat(6000)}`;
await writeFile(join(cwd, 'demo.js'), jsSource);
await writeFile(join(cwd, 'demo.py'), pySource);
await writeFile(join(cwd, 'page.html'), htmlSource);
await writeFile(join(cwd, 'evil.html'), evilSource);
await writeFile(join(cwd, 'many-lines.js'), hugeSource);
const git = (...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true });
await git('init', '-q');
await git('config', 'user.name', 'Fixture');
await git('config', 'user.email', 'fixture@example.test');
await git('add', '.');
await git('commit', '-qm', 'Initial');

const assistantText = [
  'Here is the change:',
  '```js',
  'const total = items.reduce((sum, item) => sum + item.price, 0);',
  '```',
  'And an unknown fence stays plain:',
  '```toml',
  'key = "value"',
  '```',
].join('\n');
const fixture = [
  { type: 'session', id: sessionId, cwd, version: 3, timestamp: new Date().toISOString() },
  {
    type: 'message',
    id: 'u1',
    parentId: null,
    message: { role: 'user', content: 'Show me the highlighted change.', timestamp: Date.now() },
  },
  {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    message: { role: 'assistant', content: [{ type: 'text', text: assistantText }], timestamp: Date.now() },
  },
];
await writeFile(join(sessionDir, 'native-conversation.jsonl'), fixture.map(JSON.stringify).join('\n') + '\n');

const app = createApp({
  initialCwd: cwd,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir: join(temp, 'data'),
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.5' }),
    getModels: async () => ({ models: [], default: null }),
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const local = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
let page;

async function openPage({ theme } = {}) {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  await context.addInitScript(
    ({ cwd, theme }) => {
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'code-highlight-fixture', projectOverview: false }),
      );
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false }));
      if (theme) localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme }));
    },
    { cwd, theme },
  );
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(local);
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  return context;
}

async function openFile(path) {
  await page.getByRole('tab', { name: 'Fichiers', exact: true }).click();
  const row = page.locator(`[data-file-path="${path}"]`);
  if ((await row.count()) === 0) {
    await page.getByRole('button', { name: 'Parcourir', exact: true }).click();
  }
  await row.click();
}

function viewer() {
  return page.locator('.inspector-viewer[data-inspector-unit="files"]');
}

try {
  // File preview (dark theme): numbered highlighted lines, intact text.
  let context = await openPage();
  await openFile('demo.js');
  const code = viewer().locator('.inspector-code');
  await expect(code).toBeVisible();
  await expect.poll(() => code.locator('.code-line').count(), { timeout: 20000 }).toBeGreaterThan(0);
  assert.ok((await code.locator('span[class*="hljs-"]').count()) > 0, 'expected highlighted spans');
  assert.equal(await code.textContent(), jsSource);
  await page.screenshot({ path: resolve('.local/code-highlight-preview-dark.png'), animations: 'disabled' });
  await viewer().getByRole('button', { name: 'Fermer', exact: true }).click();

  // Python and HTML previews highlight with their own grammars.
  await openFile('demo.py');
  await expect.poll(() => viewer().locator('.inspector-code .code-line').count(), { timeout: 20000 }).toBeGreaterThan(0);
  assert.ok((await viewer().locator('.inspector-code span[class*="hljs-"]').count()) > 0);
  assert.equal(await viewer().locator('.inspector-code').textContent(), pySource);
  await viewer().getByRole('button', { name: 'Fermer', exact: true }).click();

  await openFile('page.html');
  await expect.poll(() => viewer().locator('.inspector-code .code-line').count(), { timeout: 20000 }).toBeGreaterThan(0);
  assert.ok((await viewer().locator('.inspector-code span[class*="hljs-"]').count()) > 0);
  assert.equal(await viewer().locator('.inspector-code').textContent(), htmlSource);
  await viewer().getByRole('button', { name: 'Fermer', exact: true }).click();

  // Files above the highlight limits stay plain text (no line spans).
  await openFile('many-lines.js');
  const huge = viewer().locator('.inspector-code');
  await expect(huge).toContainText('const value = 123456789;');
  await page.waitForTimeout(1500);
  assert.equal(await huge.locator('.code-line').count(), 0);
  assert.equal(await huge.textContent(), hugeSource);
  await viewer().getByRole('button', { name: 'Fermer', exact: true }).click();

  // A file containing <script> never executes it and never creates elements.
  await openFile('evil.html');
  const evil = viewer().locator('.inspector-code');
  await expect(evil).toContainText('<script>');
  await page.waitForTimeout(1000);
  assert.equal(await evil.locator('script').count(), 0);
  assert.equal(await evil.textContent(), evilSource);
  assert.equal(await page.evaluate(() => window.__evil_executed), undefined);
  await viewer().getByRole('button', { name: 'Fermer', exact: true }).click();

  // Conversation: the js fence is highlighted with the option ON (default),
  // the unknown toml fence stays plain.
  await page.locator('#session-list').getByText('Show me the highlighted change.', { exact: true }).click();
  await expect(page.locator('#messages')).toContainText('Here is the change:');
  const jsBlock = page.locator('#messages pre[data-hl-language="js"]');
  await expect(jsBlock).toBeVisible();
  await expect.poll(() => jsBlock.locator('.code-line').count(), { timeout: 20000 }).toBeGreaterThan(0);
  assert.ok((await jsBlock.locator('span[class*="hljs-"]').count()) > 0);
  const tomlBlock = page.locator('#messages pre[data-hl-language="toml"]');
  await expect(tomlBlock).toBeVisible();
  await page.waitForTimeout(1000);
  assert.equal(await tomlBlock.locator('.code-line').count(), 0);
  await page.screenshot({ path: resolve('.local/code-highlight-conversation.png'), animations: 'disabled' });

  // Preference OFF (no reload): conversation blocks go back to plain text.
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  const toggle = page.locator('#settings-dialog #code-highlight, #settings-dialog [data-panel-id="code-highlight"]');
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: resolve('.local/code-highlight-preference.png'), animations: 'disabled' });
  await toggle.uncheck();
  await expect.poll(() => page.locator('#messages pre .code-line').count()).toBe(0);
  assert.ok((await jsBlock.textContent()).includes('const total = items.reduce'));
  await toggle.check();
  await expect.poll(() => jsBlock.locator('.code-line').count(), { timeout: 20000 }).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await context.close();

  // Light theme preview highlights with the Light+ palette.
  context = await openPage({ theme: 'light' });
  await openFile('demo.js');
  const light = viewer().locator('.inspector-code');
  await expect.poll(() => light.locator('.code-line').count()).toBeGreaterThan(0);
  assert.equal(await light.textContent(), jsSource);
  await page.screenshot({ path: resolve('.local/code-highlight-preview-light.png'), animations: 'disabled' });
  await context.close();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, files: ['demo.js', 'demo.py', 'page.html', 'many-lines.js', 'evil.html'], conversation: true, preference: true, themes: ['dark', 'light'] }));
} catch (error) {
  await page?.screenshot({ path: 'test-results/code-highlight-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  app.server.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
