import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const components = await readFile(new URL('../public/desktop-components.js', import.meta.url), 'utf8');
const bannerSource = app.slice(
  app.indexOf('let componentsBannerState ='),
  app.indexOf('function renderEngineComponentsAction()'),
);
const updateSource = components
  .slice(
    components.indexOf('export function needsComponentsUpdate('),
    components.indexOf('export function createDesktopComponentsPanel('),
  )
  .replace('export ', '');
const ready = {
  ready: true,
  requiredEngine: '0.9.8',
  installedEngine: '0.9.8',
  appVersion: '4.3.0-beta.3',
  server: {
    running: true,
    version: '4.3.0-beta.3',
    engineVersion: '0.9.8',
    engineAvailable: true,
    canRestart: true,
  },
};
async function bannerFor(result) {
  const nodes = Object.fromEntries(
    ['update-banner', 'update-banner-text', 'global-banner'].map((id) => [
      id,
      { hidden: true, textContent: '' },
    ]),
  );
  const calls = [];
  const context = vm.createContext({
    $: (id) => nodes[id],
    state: { readOnly: false },
    globalBannerTag: null,
    bindText: (node, fn) => {
      node.textContent = fn();
    },
    tr: (key, params) => {
      calls.push({ key, params });
      return key;
    },
    isNewComponentsBridgeAvailable: () => true,
    readComponentsStatus: async () => result,
  });
  vm.runInContext(updateSource + '\n' + bannerSource, context);
  await vm.runInContext('checkComponentsUpdateBanner()', context);
  return { hidden: nodes['update-banner'].hidden, key: nodes['update-banner-text'].textContent, calls };
}
test('current engine and Studio are quiet; unreadable runtime is not pending activation', async () => {
  assert.equal((await bannerFor(ready)).hidden, true);
  assert.equal(
    (
      await bannerFor({
        ...ready,
        needsRestart: true,
        server: { ...ready.server, error: 'server_status_failed', engineVersion: undefined },
      })
    ).hidden,
    true,
  );
});
test('Studio-only update names Studio versions, not a new engine', async () => {
  const result = await bannerFor({
    ...ready,
    serverUpdatePending: true,
    needsRestart: true,
    server: { ...ready.server, version: '4.3.0-beta.2' },
  });
  assert.equal(result.hidden, false);
  assert.equal(result.key, 'updates.banner_studio_restart');
  assert.equal(result.calls.at(-1).params.version, '4.3.0-beta.3');
  assert.equal(result.calls.at(-1).params.active, '4.3.0-beta.2');
});
test('ready stopped server asks to start, not activate an engine', async () => {
  const result = await bannerFor({
    ...ready,
    needsStart: true,
    needsRestart: false,
    server: { running: false },
  });
  assert.equal(result.key, 'updates.banner_server_start');
});
test('real engine activation, repair and unverified ownership remain explicit', async () => {
  assert.equal(
    (await bannerFor({ ...ready, needsRestart: true, server: { ...ready.server, engineVersion: '0.9.7' } }))
      .key,
    'components.banner_activate_text',
  );
  assert.equal(
    (await bannerFor({ ...ready, ready: false, needsUpdate: true })).key,
    'components.banner_text',
  );
  assert.equal(
    (
      await bannerFor({
        ...ready,
        needsRestart: true,
        serverUpdatePending: true,
        server: { ...ready.server, canRestart: false },
      })
    ).key,
    'updates.banner_unverified',
  );
});
