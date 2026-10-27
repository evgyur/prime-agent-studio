import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
const helpers = source.slice(
  source.indexOf('  // desktop-port:start'),
  source.indexOf('  // desktop-port:end'),
);
assert.ok(helpers.includes('function parseDesktopPort'), 'port helpers block is extractable');
assert.ok(helpers.includes('function desktopPortErrorKey'), 'port error helper is extractable');

function helperContext() {
  const context = vm.createContext({});
  vm.runInContext(helpers, context);
  return context;
}

test('parseDesktopPort accepts the full 1..65535 range and trims', async () => {
  const context = helperContext();
  for (const [raw, want] of [['1', 1], ['3088', 3088], ['  3189  ', 3189], ['65535', 65535]])
    assert.equal(await vm.runInContext(`parseDesktopPort(${JSON.stringify(raw)})`, context), want);
});

test('parseDesktopPort rejects out-of-range and non-numeric input', async () => {
  const context = helperContext();
  const bad = ['0', '65536', '100000', '-1', '', '   ', 'abc', '3.5', '3088x', '0x10', null, undefined];
  for (const raw of bad)
    assert.equal(await vm.runInContext(`parseDesktopPort(${JSON.stringify(raw)})`, context), null);
});

test('desktopPortErrorKey maps every stable backend error, even when wrapped', async () => {
  const context = helperContext();
  const cases = {
    port_invalid: 'settings.port_invalid',
    port_env_override: 'settings.port_env_override',
    port_unavailable: 'settings.port_unavailable',
    server_not_managed: 'settings.port_not_managed',
    server_stop_failed: 'settings.port_stop_failed',
    port_save_failed: 'settings.port_save_failed',
    update_busy: 'settings.port_busy',
  };
  for (const [code, key] of Object.entries(cases)) {
    assert.equal(await vm.runInContext(`desktopPortErrorKey(${JSON.stringify(code)})`, context), key);
    assert.equal(
      await vm.runInContext(`desktopPortErrorKey('invoke failed: ${code}')`, context),
      key,
      `${code} stays mapped when wrapped`,
    );
  }
  assert.equal(await vm.runInContext(`desktopPortErrorKey('agents_running')`, context), '');
  assert.equal(await vm.runInContext(`desktopPortErrorKey('')`, context), '');
});

// Behavior below: refresh + apply with a mocked Tauri bridge, mocked DOM and a
// canned confirm dialog. No app/server restart, no real agents.
const behavior = source.slice(
  source.indexOf('  function isPortAvailable()'),
  source.indexOf('  const portApply = '),
);
assert.ok(behavior.includes('async function refreshPort'), 'refresh block is extractable');
assert.ok(behavior.includes('async function applyPort'), 'apply block is extractable');

function behaviorContext({ invoke, readOnly = false, available = true, systemValue = null } = {}) {
  const errors = [];
  const nodes = new Map();
  const fresh = () => ({
    hidden: true,
    disabled: false,
    value: '',
    textContent: '',
    dataset: {},
    onclick: null,
    focus: () => {},
  });
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, fresh());
    return nodes.get(id);
  };
  const dialog = {
    open: false,
    returnValue: '',
    listeners: [],
    showModal() {
      this.open = true;
    },
    close(value) {
      this.returnValue = value;
      this.open = false;
      for (const fn of this.listeners.splice(0)) fn();
    },
    addEventListener(name, fn) {
      if (name === 'close') this.listeners.push(fn);
    },
  };
  nodes.set('studio-update-confirm', dialog);
  const context = vm.createContext({
    $,
    getContext: () => ({ readOnly }),
    isNewComponentsBridgeAvailable: () => available,
    system: systemValue,
    window: { __TAURI__: { core: { invoke } } },
    error: (id, value) => {
      errors.push([id, value]);
    },
    bindText: (node, value) => {
      node.textContent = typeof value === 'function' ? value() : String(value);
    },
    tr: (key, params) =>
      params ? `${key}|${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')}` : key,
    errors,
  });
  vm.runInContext(helpers, context);
  vm.runInContext(behavior, context);
  return { context, $, dialog, errors };
}

test('refreshPort renders the effective URL and stays quiet without fallback', async () => {
  const seen = [];
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      seen.push(command);
      assert.equal(command, 'desktop_port_state');
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  await vm.runInContext('refreshPort()', context);
  assert.equal($('settings-port-row').hidden, false);
  assert.equal($('settings-port').value, '3088');
  assert.equal($('settings-port').disabled, false);
  assert.equal($('settings-port-apply').disabled, false);
  assert.equal($('settings-port-status').hidden, false);
  assert.match($('settings-port-status').textContent, /settings\.port_effective/);
  assert.match($('settings-port-status').textContent, /127\.0\.0\.1:3088/);
  assert.ok(!$('settings-port-status').textContent.includes('settings.port_fallback'));
  assert.deepEqual(seen, ['desktop_port_state']);
});

test('refreshPort shows the fallback notice when the backend moved ports', async () => {
  const { context, $ } = behaviorContext({
    invoke: async () => ({ port: 3189, envOverride: false, movedFrom: 3088 }),
  });
  await vm.runInContext('refreshPort()', context);
  assert.equal($('settings-port').value, '3189');
  assert.match($('settings-port-status').textContent, /settings\.port_fallback/);
  assert.match($('settings-port-status').textContent, /preferred=3088/);
  assert.match($('settings-port-status').textContent, /127\.0\.0\.1:3189/);
});

test('refreshPort disables the field with an explanation on env override', async () => {
  const { context, $ } = behaviorContext({
    invoke: async () => ({ port: 4000, envOverride: true, movedFrom: null }),
  });
  await vm.runInContext('refreshPort()', context);
  assert.equal($('settings-port').disabled, true);
  assert.equal($('settings-port-apply').disabled, true);
  assert.match($('settings-port-status').textContent, /settings\.port_env_override/);
});

test('refreshPort hides on remote browsers and maps failures to system error', async () => {
  const hidden = behaviorContext({ readOnly: true });
  await vm.runInContext('refreshPort()', hidden.context);
  assert.equal(hidden.$('settings-port-row').hidden, true);

  const failing = behaviorContext({
    invoke: async () => {
      throw new Error('port_unavailable');
    },
  });
  await vm.runInContext('refreshPort()', failing.context);
  assert.deepEqual(failing.errors, [
    ['settings-system-error', undefined],
    ['settings-system-error', 'settings.port_unavailable'],
  ]);
});

test('applyPort rejects invalid input locally without touching the backend', async () => {
  let invoked = 0;
  const { context, $, errors } = behaviorContext({
    invoke: async () => {
      invoked += 1;
      return { changed: true, port: 1 };
    },
  });
  await vm.runInContext(`$('settings-port').value = '99999'; applyPort()`, context);
  assert.equal(invoked, 0);
  assert.deepEqual(errors, [
    ['settings-system-error', undefined],
    ['settings-system-error', 'settings.port_invalid'],
  ]);
  assert.equal($('settings-port-status').hidden, true);
});

test('applyPort announces the restart on changed:true', async () => {
  const seen = [];
  const { context, $ } = behaviorContext({
    invoke: async (command, args) => {
      seen.push([command, args == null ? args : JSON.parse(JSON.stringify(args))]);
      return { changed: true, port: 4001 };
    },
  });
  const flight = vm.runInContext(`$('settings-port').value = '4001'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Initial confirmation even with no known agents, without a count line.
  assert.match($('studio-update-confirm-note').textContent, /settings\.port_agents_note/);
  assert.ok(!$('studio-update-confirm-note').textContent.includes('count='));
  $('studio-update-proceed').onclick();
  await flight;
  assert.deepEqual(seen, [['desktop_port_set', { port: 4001, force: false }]]);
  assert.match($('settings-port-status').textContent, /settings\.port_restarting/);
});

test('applyPort shows busy status while the server stop is in flight', async () => {
  let release;
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      if (command === 'desktop_port_set') await new Promise((resolve) => { release = resolve; });
      return { changed: true, port: 4005 };
    },
  });
  const flight = vm.runInContext(`$('settings-port').value = '4005'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('studio-update-proceed').onclick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match($('settings-port-status').textContent, /settings\.port_applying/);
  assert.equal($('settings-port-apply').disabled, true);
  release();
  await flight;
  assert.match($('settings-port-status').textContent, /settings\.port_restarting/);
});

test('applyPort treats changed:false without reason as a benign no-op', async () => {
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      if (command === 'desktop_port_set')
        return { changed: false, port: 3088, envOverride: false, movedFrom: null };
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('settings-port').value = '3088'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('studio-update-proceed').onclick();
  await flight;
  assert.match($('settings-port-status').textContent, /settings\.port_same/);
});

test('applyPort confirms agents, then forces only after explicit approval', async () => {
  const runCase = async (accept) => {
    const seen = [];
    const { context, $ } = behaviorContext({
      systemValue: { activeRuns: 2 },
      invoke: async (command, args) => {
        seen.push([command, args == null ? args : JSON.parse(JSON.stringify(args))]);
        if (command === 'desktop_port_set') {
          if (args?.force === true) return { changed: true, port: 4002 };
          return { changed: false, reason: 'agents_running', port: 3088, activeRuns: 2 };
        }
        return { port: 3088, envOverride: false, movedFrom: null };
      },
    });
    const flight = vm.runInContext(`$('settings-port').value = '4002'; applyPort()`, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Initial confirmation first, even with known runs.
    assert.match($('studio-update-confirm-note').textContent, /settings\.port_agents_note/);
    assert.match($('studio-update-confirm-note').textContent, /port=4002/);
    $('studio-update-proceed').onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Refusal carries the live count for the second, forced confirmation.
    assert.match($('studio-update-confirm-note').textContent, /count=2/);
    $(accept ? 'studio-update-proceed' : 'studio-update-cancel').onclick();
    await flight;
    return { seen, $, context };
  };
  const accepted = await runCase(true);
  assert.deepEqual(
    accepted.seen.filter(([command]) => command === 'desktop_port_set'),
    [
      ['desktop_port_set', { port: 4002, force: false }],
      ['desktop_port_set', { port: 4002, force: true }],
    ],
  );
  assert.match(accepted.$('settings-port-status').textContent, /settings\.port_restarting/);

  const cancelled = await runCase(false);
  assert.deepEqual(
    cancelled.seen.filter(([command]) => command === 'desktop_port_set'),
    [['desktop_port_set', { port: 4002, force: false }]],
  );
});

test('applyPort surfaces port_save_failed with relaunch guidance', async () => {
  const { context, $, errors } = behaviorContext({
    invoke: async (command) => {
      if (command === 'desktop_port_set') throw new Error('port_save_failed: EACCES');
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('settings-port').value = '4006'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('studio-update-proceed').onclick();
  await flight;
  assert.ok(
    errors.some(
      ([id, value]) => id === 'settings-system-error' && value === 'settings.port_save_failed',
    ),
    'the save failure explains the stopped server and the relaunch',
  );
});

test('applyPort maps a thrown port_unavailable without forcing anything', async () => {
  const seen = [];
  const { context, $, errors } = behaviorContext({
    invoke: async (command) => {
      seen.push(command);
      if (command === 'desktop_port_set') throw new Error('port_unavailable');
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('settings-port').value = '4003'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('studio-update-proceed').onclick();
  await flight;
  assert.deepEqual(
    seen.filter((command) => command === 'desktop_port_set'),
    ['desktop_port_set'],
  );
  assert.ok(
    errors.some(
      ([id, value]) => id === 'settings-system-error' && value === 'settings.port_unavailable',
    ),
    'the refusal is mapped to the translated port error',
  );
});

test('applyPort asks an initial confirmation and invokes nothing on cancel', async () => {
  const seen = [];
  const { context, $ } = behaviorContext({
    invoke: async (command, args) => {
      seen.push([command, args == null ? args : JSON.parse(JSON.stringify(args))]);
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('settings-port').value = '4002'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match($('studio-update-confirm-note').textContent, /settings\.port_agents_note/);
  $('studio-update-cancel').onclick();
  await flight;
  assert.deepEqual(
    seen.filter(([command]) => command === 'desktop_port_set'),
    [],
    'cancel before any attempt stops nothing',
  );
  assert.equal($('settings-port').value, '3088');
});

test('applyPort failure keeps the requested value and the failure visible', async () => {
  const seen = [];
  const { context, $, errors } = behaviorContext({
    invoke: async (command) => {
      seen.push(command);
      if (command === 'desktop_port_set') throw new Error('port_unavailable');
      return { port: 50745, envOverride: false, movedFrom: 56427 };
    },
  });
  // Stale startup fallback rendered first, like a real launch.
  await vm.runInContext('refreshPort()', context);
  assert.match($('settings-port-status').textContent, /settings\.port_fallback/);
  const flight = vm.runInContext(`$('settings-port').value = '3088'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('studio-update-proceed').onclick();
  await flight;
  // Requested-port failure dominates: value kept, error shown, no stale fallback.
  assert.equal($('settings-port').value, '3088');
  assert.match($('settings-port-status').textContent, /settings\.port_unavailable/);
  assert.ok(!$('settings-port-status').textContent.includes('settings.port_fallback'));
  assert.ok(
    errors.some(([id, value]) => id === 'settings-system-error' && value === 'settings.port_unavailable'),
  );
  assert.deepEqual(
    seen.filter((command) => command === 'desktop_port_set'),
    ['desktop_port_set'],
  );
  assert.deepEqual(
    seen.filter((command) => command === 'desktop_port_state'),
    ['desktop_port_state'],
    'no re-read wipes the failure or the requested value',
  );
});
