import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../desktop/desktop.js', import.meta.url), 'utf8');
const helpers = source.slice(
  source.indexOf('// desktop-port:start'),
  source.indexOf('// desktop-port:end'),
);
assert.ok(helpers.includes('function parsePortInput'), 'launcher port helpers are extractable');
assert.ok(helpers.includes('function portErrorText'), 'launcher port error helper is extractable');

const T = {
  portInvalid: 'INVALID',
  portEnvOverride: 'ENV',
  portUnavailable: 'UNAVAIL',
  portNotManaged: 'NOTMAN',
  portStopFailed: 'STOPFAIL',
  portSaveFailed: 'SAVEFAIL',
  portBusy: 'BUSY',
  portSame: 'SAME',
  portRestarting: 'RESTARTING',
  portNote: 'NOTE',
  portApplying: 'APPLYING',
  portFallback: 'FB preferred={preferred} port={port}',
  portUrl: 'URL {url}',
  portRestartNote: 'APPLY {port}',
  restartTitle: 'RT',
  serverBusy: 'BUSYAGENTS',
};

function helperContext() {
  const context = vm.createContext({ t: { ...T } });
  vm.runInContext(helpers, context);
  return context;
}

test('parsePortInput accepts the full 1..65535 range and trims', async () => {
  const context = helperContext();
  for (const [raw, want] of [['1', 1], ['3088', 3088], ['  3189  ', 3189], ['65535', 65535]])
    assert.equal(await vm.runInContext(`parsePortInput(${JSON.stringify(raw)})`, context), want);
});

test('parsePortInput rejects out-of-range and non-numeric input', async () => {
  const context = helperContext();
  const bad = ['0', '65536', '-1', '', 'abc', '3.5', '3088x', null, undefined];
  for (const raw of bad)
    assert.equal(await vm.runInContext(`parsePortInput(${JSON.stringify(raw)})`, context), null);
});

test('portErrorCode finds every stable backend error, even when wrapped', async () => {
  const context = helperContext();
  for (const code of [
    'port_invalid',
    'port_env_override',
    'port_unavailable',
    'server_not_managed',
    'server_stop_failed',
    'port_save_failed',
    'update_busy',
  ]) {
    assert.equal(await vm.runInContext(`portErrorCode(${JSON.stringify(code)})`, context), code);
    assert.equal(await vm.runInContext(`portErrorCode('boom: ${code}!')`, context), code);
  }
  assert.equal(await vm.runInContext(`portErrorCode('agents_running')`, context), '');
  assert.equal(await vm.runInContext(`portErrorCode('')`, context), '');
});

test('portErrorText renders through the launcher messages', async () => {
  const context = helperContext();
  const cases = {
    port_invalid: 'INVALID',
    port_env_override: 'ENV',
    port_unavailable: 'UNAVAIL',
    server_not_managed: 'NOTMAN',
    server_stop_failed: 'STOPFAIL',
    port_save_failed: 'SAVEFAIL',
    update_busy: 'BUSY',
  };
  for (const [code, text] of Object.entries(cases))
    assert.equal(await vm.runInContext(`portErrorText(${JSON.stringify(code)})`, context), text);
  assert.equal(await vm.runInContext(`portErrorText('nope')`, context), '');
});

// Behavior below: render + refresh + apply with a mocked Tauri bridge, mocked
// DOM and the restart-confirm dialog. No app/server restart, no real agents.
const behavior = source.slice(
  source.indexOf('function setPortError'),
  source.indexOf('let quitting = false;'),
);
assert.ok(behavior.includes('function renderPortState'), 'render block is extractable');
assert.ok(behavior.includes('async function applyPort'), 'apply block is extractable');

function behaviorContext({ invoke } = {}) {
  const nodes = new Map();
  const fresh = () => ({
    hidden: true,
    disabled: false,
    value: '',
    textContent: '',
    returnValue: '',
    listeners: [],
    onclick: null,
    focus: () => {},
  });
  const $ = (id) => {
    if (!nodes.has(id)) {
      const node = fresh();
      if (id === 'restart-confirm') {
        node.open = false;
        node.showModal = function () {
          this.open = true;
        };
        node.close = function (value) {
          this.returnValue = value;
          this.open = false;
          for (const fn of this.listeners.splice(0)) fn();
        };
        node.addEventListener = function (name, fn) {
          if (name === 'close') this.listeners.push(fn);
        };
      }
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const context = vm.createContext({ t: { ...T }, $, invoke });
  vm.runInContext(helpers, context);
  vm.runInContext(behavior, context);
  return { context, $ };
}

test('renderPortState shows the effective URL and hides the fallback when steady', async () => {
  const { context, $ } = behaviorContext();
  const moved = await vm.runInContext(
    'renderPortState({ port: 3088, envOverride: false, movedFrom: null })',
    context,
  );
  assert.equal(moved, false);
  assert.equal($('port-input').value, '3088');
  assert.equal($('port-input').disabled, false);
  assert.equal($('port-apply').disabled, false);
  assert.equal($('port-note').textContent, 'NOTE');
  assert.equal($('port-fallback').hidden, true);
  assert.equal($('port-url').hidden, false);
  assert.match($('port-url').textContent, /127\.0\.0\.1:3088/);
});

test('renderPortState shows the fallback notice when the backend moved ports', async () => {
  const { context, $ } = behaviorContext();
  const moved = await vm.runInContext(
    'renderPortState({ port: 3189, envOverride: false, movedFrom: 3088 })',
    context,
  );
  assert.equal(moved, true);
  assert.equal($('port-fallback').hidden, false);
  assert.match($('port-fallback').textContent, /preferred=3088/);
  assert.match($('port-fallback').textContent, /port=3189/);
  assert.match($('port-url').textContent, /127\.0\.0\.1:3189/);
});

test('renderPortState disables the field with an explanation on env override', async () => {
  const { context, $ } = behaviorContext();
  await vm.runInContext('renderPortState({ port: 4000, envOverride: true, movedFrom: null })', context);
  assert.equal($('port-input').disabled, true);
  assert.equal($('port-apply').disabled, true);
  assert.equal($('port-note').textContent, 'ENV');
});

test('refreshPortState maps failures to the inline error', async () => {
  const { context, $ } = behaviorContext({
    invoke: async () => {
      throw new Error('port_unavailable');
    },
  });
  await vm.runInContext('refreshPortState()', context);
  assert.equal($('port-error').hidden, false);
  assert.equal($('port-error').textContent, 'UNAVAIL');
});

test('applyPort rejects invalid input locally without touching the backend', async () => {
  let invoked = 0;
  const { context, $ } = behaviorContext({
    invoke: async () => {
      invoked += 1;
      return { changed: true, port: 1 };
    },
  });
  await vm.runInContext(`$('port-input').value = 'abc'; applyPort()`, context);
  assert.equal(invoked, 0);
  assert.equal($('port-error').hidden, false);
  assert.equal($('port-error').textContent, 'INVALID');
});

test('applyPort announces the restart on changed:true', async () => {
  const seen = [];
  const { context, $ } = behaviorContext({
    invoke: async (command, args) => {
      seen.push([command, args == null ? args : JSON.parse(JSON.stringify(args))]);
      return { changed: true, port: 4001 };
    },
  });
  const flight = vm.runInContext(`$('port-input').value = '4001'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Initial confirmation even with no known agents, without a busy suffix.
  assert.match($('restart-confirm-note').textContent, /APPLY 4001/);
  assert.ok(!$('restart-confirm-note').textContent.includes('BUSYAGENTS'));
  $('restart-proceed').onclick();
  await flight;
  assert.deepEqual(seen, [['desktop_port_set', { port: 4001, force: false }]]);
  assert.equal($('port-note').textContent, 'RESTARTING');
});

test('applyPort shows busy status while the server stop is in flight', async () => {
  let release;
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      if (command === 'desktop_port_set') await new Promise((resolve) => { release = resolve; });
      return { changed: true, port: 4005 };
    },
  });
  const flight = vm.runInContext(`$('port-input').value = '4005'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('restart-proceed').onclick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal($('port-note').textContent, 'APPLYING');
  assert.equal($('port-apply').disabled, true);
  release();
  await flight;
  assert.equal($('port-note').textContent, 'RESTARTING');
});

test('applyPort treats changed:false without reason as a benign no-op', async () => {
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      if (command === 'desktop_port_set')
        return { changed: false, port: 3088, envOverride: false, movedFrom: null };
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('port-input').value = '3088'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('restart-proceed').onclick();
  await flight;
  assert.equal($('port-note').textContent, 'SAME');
});

test('applyPort reuses the restart confirm and forces only after approval', async () => {
  const runCase = async (accept) => {
    const seen = [];
    const { context, $ } = behaviorContext({
      invoke: async (command, args) => {
        seen.push([command, args == null ? args : JSON.parse(JSON.stringify(args))]);
        if (command === 'desktop_port_set') {
          if (args?.force === true) return { changed: true, port: 4002 };
          return { changed: false, reason: 'agents_running', port: 3088, activeRuns: 1 };
        }
        return { port: 3088, envOverride: false, movedFrom: null };
      },
    });
    const flight = vm.runInContext(`$('port-input').value = '4002'; applyPort()`, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Initial confirmation first, without an agent suffix.
    assert.equal($('restart-confirm-title').textContent, 'RT');
    assert.match($('restart-confirm-note').textContent, /APPLY 4002/);
    assert.ok(!$('restart-confirm-note').textContent.includes('BUSYAGENTS'));
    $('restart-proceed').onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Refusal carries the live count for the second, forced confirmation.
    assert.match($('restart-confirm-note').textContent, /BUSYAGENTS/);
    $(accept ? 'restart-proceed' : 'restart-cancel').onclick();
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
  assert.equal(accepted.$('port-note').textContent, 'RESTARTING');

  const cancelled = await runCase(false);
  assert.deepEqual(
    cancelled.seen.filter(([command]) => command === 'desktop_port_set'),
    [['desktop_port_set', { port: 4002, force: false }]],
  );
});

test('applyPort surfaces port_save_failed with relaunch guidance', async () => {
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      if (command === 'desktop_port_set') throw new Error('port_save_failed: EACCES');
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('port-input').value = '4006'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('restart-proceed').onclick();
  await flight;
  assert.equal($('port-error').hidden, false);
  assert.equal($('port-error').textContent, 'SAVEFAIL');
});

test('applyPort maps a thrown port_unavailable without forcing anything', async () => {
  const seen = [];
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      seen.push(command);
      if (command === 'desktop_port_set') throw new Error('port_unavailable');
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('port-input').value = '4003'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('restart-proceed').onclick();
  await flight;
  assert.deepEqual(
    seen.filter((command) => command === 'desktop_port_set'),
    ['desktop_port_set'],
  );
  assert.equal($('port-error').textContent, 'UNAVAIL');
});

test('applyPort asks an initial confirmation and invokes nothing on cancel', async () => {
  const seen = [];
  const { context, $ } = behaviorContext({
    invoke: async (command, args) => {
      seen.push([command, args == null ? args : JSON.parse(JSON.stringify(args))]);
      return { port: 3088, envOverride: false, movedFrom: null };
    },
  });
  const flight = vm.runInContext(`$('port-input').value = '4002'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match($('restart-confirm-note').textContent, /APPLY 4002/);
  $('restart-cancel').onclick();
  await flight;
  assert.deepEqual(
    seen.filter(([command]) => command === 'desktop_port_set'),
    [],
    'cancel before any attempt stops nothing',
  );
  assert.equal($('port-input').value, '3088');
});

test('applyPort failure keeps the requested value and the failure visible', async () => {
  const seen = [];
  const { context, $ } = behaviorContext({
    invoke: async (command) => {
      seen.push(command);
      if (command === 'desktop_port_set') throw new Error('port_unavailable');
      return { port: 50745, envOverride: false, movedFrom: 56427 };
    },
  });
  // Stale startup fallback rendered first, like a real launch.
  await vm.runInContext('refreshPortState()', context);
  assert.equal($('port-fallback').hidden, false);
  const flight = vm.runInContext(`$('port-input').value = '3088'; applyPort()`, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('restart-proceed').onclick();
  await flight;
  // Requested-port failure dominates: value kept, error shown, no fresh fallback copy.
  assert.equal($('port-input').value, '3088');
  assert.equal($('port-error').textContent, 'UNAVAIL');
  assert.equal($('port-note').textContent, 'UNAVAIL');
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
