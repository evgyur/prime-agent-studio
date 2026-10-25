// Real WebView IPC and restart, exclusively against a separately identified test build.
// Build with: tauri build --debug --no-bundle --config test/fixtures/components-pipeline-tauri.json
// The config must set identifier to com.primeagent.studio.pipeline-test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { startServer } from './start-server.mjs';
import { stopServer } from './stop-server.mjs';
import { probeHealth } from './launcher-common.mjs';

const exe = process.env.PRIME_STUDIO_TEST_EXE;
assert.ok(exe, 'Explicit isolated test executable required');
assert.ok(
  (await readFile(exe)).includes(Buffer.from('com.primeagent.studio.pipeline-test')),
  'Refusing to launch an executable with the production single-instance identity',
);
assert.ok(
  process.env.PRIME_AGENT_CLI && process.env.PRIME_AGENT_KERNEL_PYTHON,
  'Use an already validated isolated engine and Python; this test never downloads components',
);
const root = await mkdtemp(join(tmpdir(), 'studio-components-pipeline-'));
const dataRoot = join(root, 'desktop'),
  dataDir = join(dataRoot, 'data');
const agentHome = join(root, 'agent'),
  sessionDir = join(root, 'sessions');
await Promise.all([dataDir, agentHome, sessionDir].map((p) => mkdir(p, { recursive: true })));
// Legitimate old generation for the hardened ownership check:
// temp <dataRoot>/versions/<64hex>/node.exe + studio/server.mjs + ready.json.
// startServer spawns exactly <gen>/node.exe <gen>/studio/server.mjs (2 argv).
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const oldIdentity = randomBytes(32).toString('hex');
const oldGen = join(dataRoot, 'versions', oldIdentity);
const oldStudio = join(oldGen, 'studio');
await mkdir(oldStudio, { recursive: true });
const packagedNode = resolve('src-tauri/target/debug/backend/node.exe');
const nodeSource = existsSync(packagedNode) ? packagedNode : process.execPath;
await copyFile(nodeSource, join(oldGen, 'node.exe'));
const oldVersion = '3.6.2';
await writeFile(
  join(oldStudio, 'server.mjs'),
  `
import {createServer} from 'node:http';
let active = true;
createServer((req,res) => {
  res.setHeader('Content-Type','application/json');
  if(req.url === '/api/health') res.end(JSON.stringify({service:'prime-agent-gui',status:'ok',pid:process.pid,instanceId:process.env.PRIME_AGENT_GUI_INSTANCE,version:'${oldVersion}'}));
  else if(req.url === '/api/runs') res.end(JSON.stringify({runs: active ? [{id:'synthetic',status:'running'}] : []}));
  else if(req.url === '/api/version') res.end(JSON.stringify({available:true,version:'0.9.4'}));
  else if(req.url === '/test-idle') {active=false;res.end('{}');}
  else {res.statusCode=404;res.end('{}');}
}).listen(Number(process.env.PORT),'127.0.0.1');
`,
);
await writeFile(join(oldGen, 'ready.json'), JSON.stringify({ identity: oldIdentity, version: oldVersion }));
const freePort = async () => {
  const s = createServer();
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const port = s.address().port;
  await new Promise((done) => s.close(done));
  return port;
};
const port = await freePort(),
  debugPort = await freePort(),
  url = `http://127.0.0.1:${port}`;
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({ telemetry: { enabled: false, noticeShown: true } }),
);
await writeFile(
  join(dataDir, 'workspace.json'),
  JSON.stringify({ projects: [], removedProjects: [], sessions: {} }),
);
let child, browser;
try {
  const old = await startServer({
    root: oldStudio,
    node: join(oldGen, 'node.exe'),
    port,
    env: { ...process.env, PRIME_AGENT_GUI_DATA_DIR: dataDir },
  });
  assert.ok(!old.reused, 'Old generation must be a fresh start, not a reused server.');
  child = spawn(resolve(exe), ['--background'], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PRIME_STUDIO_DESKTOP_DATA_ROOT: dataRoot,
      PRIME_STUDIO_DESKTOP_PORT: String(port),
      PRIME_AGENT_CODING_AGENT_DIR: agentHome,
      PRIME_AGENT_SESSION_DIR: sessionDir,
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${debugPort}/json/version`)
          .then((r) => r.ok)
          .catch(() => false),
      { timeout: 30000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = browser.contexts()[0].pages()[0];
  // Keep the isolated native window hidden, then exercise the foreground guide
  // through its packaged document rather than bringing a test window to front.
  await expect.poll(() => page.url(), { timeout: 45000 }).toContain(url);
  await page.goto('http://tauri.localhost/index.html?settings');
  // Removed UI stays removed: single clear flow (Repair / Restart + Back).
  await expect(page.locator('#components-apply')).toHaveCount(0);
  await expect(page.locator('#migration-dialog')).toHaveCount(0);
  await expect(page.locator('#components')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#components-install')).toBeHidden({ timeout: 45000 });
  assert.equal(
    (await probeHealth(port)).health.pid,
    old.pid,
    'opening the guide never restarts the old server',
  );
  // Permanent regression assertion: the real native bridge must diagnose ready
  // over readonly IPC (the stdin EOF bug once returned cancelled here).
  const initialDiagnose = await page.evaluate(() =>
    window.__TAURI__.core.invoke('desktop_components', { action: 'diagnose', component: null }),
  );
  assert.equal(initialDiagnose.ready, true, 'initial real diagnose over the native bridge must be ready');
  assert.equal(initialDiagnose.requiredEngine, '0.9.8');
  // Real UI receipt path: Back to Studio persists via activate, then returns to
  // the warm old server without restarting it.
  await expect(page.locator('#back-studio')).toBeVisible({ timeout: 45000 });
  await page.locator('#back-studio').click();
  await expect.poll(() => page.url(), { timeout: 45000 }).toContain(url);
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(join(dataRoot, 'engine/installation.json'), 'utf8')).components
            ?.engine?.version;
        } catch {
          return null;
        }
      },
      { timeout: 60000 },
    )
    .toBe('0.9.8');
  assert.equal(
    (await probeHealth(port)).health.pid,
    old.pid,
    'Back to Studio persists the receipt without restarting the old server',
  );
  await page.goto('http://tauri.localhost/index.html?settings');
  await expect(page.locator('#components')).toBeVisible({ timeout: 45000 });
  // Busy guard: a completed activation must not look like a live installer.
  // Cancelling the restart confirmation keeps the old server untouched.
  const completed = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_operation'));
  assert.equal(completed.operation?.terminal, true, 'activation is settled before the restart check');
  await expect(page.locator('#server-restart')).toBeEnabled({ timeout: 45000 });
  await page.locator('#server-restart').click();
  await expect(page.locator('#restart-confirm')).toBeVisible({ timeout: 15000 });
  await page.locator('#restart-cancel').click();
  await expect(page.locator('#restart-confirm')).toBeHidden({ timeout: 15000 });
  assert.equal((await probeHealth(port)).health.pid, old.pid, 'cancelled restart never stops the old server');
  // Idle activation through the one explicit Restart now control.
  await fetch(url + '/test-idle');
  await page.locator('#server-restart').click();
  await expect.poll(async () => (await probeHealth(port)).health?.version, { timeout: 90000 }).toBe(version);
  // The native restart navigates to Studio; the old shell acknowledgement can
  // disappear with its document. Verify the new page and persisted operation.
  await page.waitForURL((current) => current.origin === url, { timeout: 45000 });
  await expect
    .poll(() => page.evaluate(() => window.__PRIME_STUDIO_COMPONENTS_PANEL__), { timeout: 45000 })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { operation } = await window.__TAURI__.core.invoke('desktop_update_operation');
          return { kind: operation?.kind, terminal: operation?.terminal, stage: operation?.stage };
        }),
      { timeout: 45000 },
    )
    .toEqual({ kind: 'restart', terminal: true, stage: 'done' });
  await expect
    .poll(() => page.evaluate(() => typeof window.__PRIME_STUDIO_OPEN_UPDATES__), { timeout: 45000 })
    .toBe('function');
  await page.evaluate(() => window.__TAURI__.core.invoke('desktop_components_open'));
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
  const details = page.locator('#studio-update-details');
  if (!(await details.evaluate((node) => node.open))) await details.locator(':scope > summary').click();
  await expect(page.locator('#studio-update-components')).toBeVisible({ timeout: 45000 });
  // Real main-WebView progress Channel on the tracked prepare mutation.
  // prepare installs/validates with the isolated receipt only, never restarts.
  const proof = await page.evaluate(async () => {
    const phases = [];
    const onProgress = new window.__TAURI__.core.Channel();
    onProgress.onmessage = (p) => phases.push(p.stage);
    const result = await window.__TAURI__.core.invoke('desktop_components', {
      action: 'prepare',
      component: null,
      onProgress,
    });
    return { result, phases };
  });
  assert.equal(proof.result.ready, true);
  assert.ok(proof.phases.includes('validation'), 'real main-WebView progress Channel is delivered');
  // Read-only diagnosis carries no progress Channel by design; assert the payload.
  const diagnosed = await page.evaluate(() =>
    window.__TAURI__.core.invoke('desktop_components', { action: 'diagnose', component: null }),
  );
  assert.equal(diagnosed.ready, true);
  assert.equal(diagnosed.requiredEngine, '0.9.8');
  assert.equal(diagnosed.needsRestart, false);
  await page.evaluate(() => document.querySelector('#settings-dialog').close());
  await page.evaluate(() => window.__TAURI__.core.invoke('desktop_components_open'));
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
  assert.equal(browser.contexts()[0].pages().length, 1, 'normal settings never opens a duplicate window');
  // The removed advanced-model pickers are gone; with no legacy values the
  // legacy card stays hidden and Escape changes nothing.
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  await expect(page.locator('#model-config-loading')).toBeHidden({ timeout: 45000 });
  await expect(page.locator('#model-config-content')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#engine-settings')).toBeHidden({ timeout: 45000 });
  assert.equal(await page.locator('[data-engine-model]').count(), 0);
  assert.equal(await page.locator('#reset-legacy-settings').count(), 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#model-config-dialog').close());
  await page.locator('#settings-tab-updates').click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/components-native-pipeline.png' });
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'removed migration/apply UI absent, opening/Back to Studio never restarts',
        'busy restart guard with cancel keeps old server',
        'idle activation to installed server via explicit Restart now',
        'real main-WebView prepare IPC with progress Channel',
        'read-only diagnose payload ready',
        'one settings surface',
        'shared advanced model picker and Escape preserving draft',
      ],
      root,
    }),
  );
} catch (error) {
  await mkdir('test-results', { recursive: true });
  const page = browser?.contexts()[0]?.pages()[0];
  const withTimeout = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('diagnostic-timeout')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const safeInvoke = async (label, fn, ms = 8000) => {
    try {
      if (!page) return { state: 'no-page' };
      return await withTimeout(fn(), ms);
    } catch (invokeError) {
      return { state: `error:${label}`, message: String(invokeError?.message || invokeError).slice(0, 2000) };
    }
  };
  const diagnostic = {
    error: String(error?.message || error).slice(0, 4000),
    page: page?.url(),
    status: await page
      ?.locator('#components-status')
      .textContent()
      .catch(() => null),
    bridge: await page?.evaluate(() => Boolean(window.__TAURI__?.core?.invoke)).catch(() => null),
    componentsStatusRaw: await safeInvoke('components-status', () =>
      page.evaluate(() =>
        window.__TAURI__.core.invoke('desktop_components', { action: 'status', component: null }),
      ),
    ),
    componentsDiagnoseRaw: await safeInvoke('components-diagnose', () =>
      page.evaluate(() =>
        window.__TAURI__.core.invoke('desktop_components', { action: 'diagnose', component: null }),
      ),
    ),
    desktopStatusRaw: await safeInvoke('desktop-status', () =>
      page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_status')),
    ),
    desktopOperationRaw: await safeInvoke('desktop-operation', () =>
      page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_operation')),
    ),
    health: await probeHealth(port).catch(() => null),
    installation: await readFile(join(dataRoot, 'engine/installation.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
    serverMarker: await readFile(join(dataDir, 'server.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
    logTail: await readFile(join(dataRoot, 'engine/logs/components.log'), 'utf8')
      .then((text) => text.slice(-8000))
      .catch(() => null),
    dom: await page
      ?.evaluate(() => {
        const ids = [
          'components',
          'components-install',
          'components-status',
          'server-restart',
          'server-state',
          'server-agents',
          'restart-confirm',
          'update-status',
          'studio-update-components',
          'settings-dialog',
        ];
        const snapshot = { title: document.title, url: location.href, ids: {} };
        for (const id of ids) {
          const node = document.getElementById(id);
          if (!node) snapshot.ids[id] = null;
          else
            snapshot.ids[id] = {
              hidden: Boolean(node.hidden),
              open: 'open' in node ? Boolean(node.open) : undefined,
              disabled: 'disabled' in node ? Boolean(node.disabled) : undefined,
              text: String(node.textContent || '').slice(0, 500),
            };
        }
        return snapshot;
      })
      .catch(() => null),
  };
  const diagnosticJson = JSON.stringify(diagnostic, null, 2);
  await writeFile(
    'test-results/components-native-failure.json',
    diagnosticJson.length <= 60000
      ? diagnosticJson
      : JSON.stringify({ error: diagnostic.error, truncated: diagnosticJson.slice(0, 50000) }),
  );
  await page?.screenshot({ path: 'test-results/components-native-failure.png' }).catch(() => {});
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once('exit', done));
    child.kill();
    await exited;
  }
  await browser?.close().catch(() => {});
  await stopServer({ root: oldStudio, dataDir });
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
