import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
const refreshSource = source.slice(
  source.indexOf('  async function refreshAutostart()'),
  source.indexOf('  // desktop-port:start'),
);
for (const previous of [false, true]) {
  test(`autostart reads booleans but never presents unknown as OFF (previous ${previous})`, async () => {
    const note = { dataset: {}, textContent: '' };
    const input = { checked: previous };
    const row = { hidden: true, querySelector: () => note };
    let response;
    const calls = [];
    const context = vm.createContext({
      $: (id) => (id === 'settings-autostart-row' ? row : input),
      isAutostartAvailable: () => true,
      tr: (key) => key,
      bindText: (node, value) => {
        node.textContent = value();
      },
      window: {
        __TAURI__: {
          core: {
            invoke: async (command) => {
              calls.push(command);
              if (response instanceof Error) throw response;
              return { autostart: response };
            },
          },
        },
      },
    });
    vm.runInContext(refreshSource, context);
    for (const value of [null, undefined, new Error('registry_unreadable')]) {
      response = value;
      await vm.runInContext('refreshAutostart()', context);
      assert.equal(input.checked, previous);
      assert.equal(input.indeterminate, true);
      assert.equal(input.disabled, true);
      assert.equal(note.dataset.i18n, 'settings.autostart_unavailable');
      assert.equal(note.textContent, 'settings.autostart_unavailable');
    }
    for (const value of [true, false]) {
      response = value;
      await vm.runInContext('refreshAutostart()', context);
      assert.equal(input.checked, value);
      assert.equal(input.indeterminate, false);
      assert.equal(input.disabled, false);
      assert.equal(note.dataset.i18n, 'settings.autostart_note');
    }
    assert.equal(row.hidden, false);
    assert.ok(
      calls.every((command) => command === 'desktop_state'),
      'refresh never writes a Windows setting',
    );
  });
}
