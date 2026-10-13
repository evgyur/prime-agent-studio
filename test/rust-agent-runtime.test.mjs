import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { createAgentRuntime, createEventProjection } from '../lib/agent.mjs';
import { createRustAgentRuntime } from '../lib/rust-agent-runtime.mjs';

test('native tool updates and ends retain names from interleaved starts', () => {
  const project = createEventProjection();
  assert.equal(
    project({ type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'python_repl', args: {} })[0]
      .name,
    'python_repl',
  );
  assert.equal(
    project({ type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'other', args: {} })[0].name,
    'other',
  );
  assert.equal(
    project({ type: 'tool_execution_update', toolCallId: 'call-a', partialResult: { content: [] } })[0].name,
    'python_repl',
  );
  assert.deepEqual(
    project({ type: 'tool_execution_end', toolCallId: 'call-b', result: { content: [] }, isError: true })[0],
    {
      kind: 'tool_end',
      id: 'call-b',
      name: 'other',
      result: { content: [] },
      isError: true,
    },
  );
  assert.deepEqual(
    project({
      type: 'tool_execution_end',
      toolCallId: 'call-a',
      result: { content: [{ type: 'text', text: 'marker' }] },
      isError: false,
    })[0],
    {
      kind: 'tool_end',
      id: 'call-a',
      name: 'python_repl',
      result: { content: [{ type: 'text', text: 'marker' }] },
      isError: false,
    },
  );
  assert.equal(
    project({ type: 'tool_execution_update', toolCallId: 'call-a', partialResult: { content: [] } })[0].name,
    '',
  );
});

test('Rust opt-in requires the JavaScript metadata package and rejects JS-only policy', () => {
  assert.throws(
    () =>
      createAgentRuntime({
        rustCliPath: join(tmpdir(), 'prime-agent'),
        cliPath: join(tmpdir(), 'missing-prime-agent-cli.js'),
      }),
    /JavaScript package for Studio model metadata/,
  );
  assert.throws(
    () =>
      createRustAgentRuntime(
        { rustCliPath: join(tmpdir(), 'prime-agent'), subagentPolicyFile: join(tmpdir(), 'policy.json') },
        {
          metadata: { agentHome: tmpdir(), sessionDir: join(tmpdir(), 'sessions') },
          cli: { packageDir: tmpdir() },
        },
      ),
    /cannot enforce Studio’s JavaScript subagent policy/,
  );
});

async function fixture(
  t,
  { completion = { enabled: false }, holdPrompt = false, cleanupError = false, endTurn } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'prime-rust-runtime-'));
  const events = [],
    commands = [],
    clients = [];
  let launch,
    ended = 0,
    closed = 0;
  class Client {
    protocolClientId = 'test-owner';
    async connect() {
      clients.push(this);
    }
    async waitForHello() {
      return {
        supervisorPid: 123,
        serverCapabilities: [
          'client_owned_sessions',
          'event_sequence',
          'rlm_quiescence_barrier',
          'queue_message_mutation',
        ],
      };
    }
    onMessage(fn) {
      this.message = fn;
      return () => {
        this.message = undefined;
      };
    }
    onClose(fn) {
      this.disconnected = fn;
      return () => {
        this.disconnected = undefined;
      };
    }
    close() {
      this.closed = true;
      this.rejectPrompt?.(new Error('closed'));
    }
    async request(command) {
      commands.push(command);
      if (command.type === 'create')
        return {
          success: true,
          data: {
            activeSessionId: 'active-1',
            sessionId: 'session-1',
            cwd,
            sessionFile: join(cwd, 'session-1.jsonl'),
            workerPid: 124,
          },
        };
      if (command.type === 'prompt' && holdPrompt)
        return new Promise((resolve, reject) => {
          this.rejectPrompt = reject;
        });
      if (command.type === 'wait_for_headless_completion') return { success: true, data: completion };
      return { success: true, data: {} };
    }
  }
  const runtime = createRustAgentRuntime(
    {
      rustCliPath: join(cwd, 'prime-agent'),
      env: { NODE_OPTIONS: 'legacy-hook', PRIME_AGENT_KERNEL_PYTHON: 'old-python' },
    },
    {
      metadata: {
        agentHome: cwd,
        sessionDir: join(cwd, 'sessions'),
        close: async () => {},
        getModels: async () => [],
      },
      cli: { packageDir: cwd },
      Client,
      projectEvents: () => (event) => [event],
      makeDaemon: (options) => {
        launch = options;
        return {
          socketPath: 'test',
          pid: 123,
          ensureReady: async () => ({ pid: 123 }),
          close: async () => {},
        };
      },
      makeTools: () => ({
        ready: Promise.resolve(),
        appendSystemPrompt: (s) => s,
        bindSession() {},
        beginTurn: async () => {},
        respond() {},
        endTurn: async () => {
          ended++;
          await endTurn?.();
        },
        close: async () => {
          closed++;
          if (cleanupError) throw new Error('cleanup failed');
        },
      }),
    },
  );
  t.after(async () => {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const run = await runtime.start({ cwd, message: 'test', onEvent: (e) => events.push(e) });
  return {
    runtime,
    run,
    events,
    commands,
    clients,
    launch,
    get closed() {
      return closed;
    },
    get ended() {
      return ended;
    },
  };
}

test('native completion keeps isolated runtime env and releases the owned worker', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run.done).status, 'completed');
  assert.equal(f.launch.env.DO_NOT_TRACK, '1');
  assert.equal(f.launch.env.NODE_OPTIONS, undefined);
  assert.equal(f.launch.env.PRIME_AGENT_KERNEL_PYTHON, undefined);
  assert.match(f.launch.env.PRIME_AGENT_KERNEL_VENV, /kernel-venv-rust$/);
  assert.equal(f.launch.env.PRIME_STUDIO_SUBAGENT_POLICY, undefined);
  assert.equal(f.commands.filter((c) => c.type === 'complete_owned_session').length, 1);
  assert.equal(f.commands.find((c) => c.type === 'wait_for_headless_completion').waitForRlmQuiescence, true);
  assert(Array.isArray(f.commands.find((c) => c.type === 'create').config.appendSystemPrompt));
  assert.equal(f.closed, 1);
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1'), undefined);
});

test('unsupported Rust-only gaps fail before creating a native session', async (t) => {
  const f = await fixture(t);
  await f.run.done;
  const before = f.commands.filter((command) => command.type === 'create').length;
  await assert.rejects(
    f.runtime.start({ cwd: f.runtime.agentHome, message: 'test', computerUse: true }),
    /Computer Use is unavailable/,
  );
  await assert.rejects(
    f.runtime.start({ cwd: f.runtime.agentHome, message: 'test', files: [{ name: 'a.txt' }] }),
    /file attachments are unavailable/i,
  );
  await assert.rejects(
    f.runtime.start({ cwd: f.runtime.agentHome, message: 'test', model: 'meta/muse-spark-1.3' }),
    /Meta provider is unavailable/,
  );
  assert.equal(f.commands.filter((command) => command.type === 'create').length, before);
});

test('native autonomous gate failure and ungated budget exhaustion cannot report success', async (t) => {
  for (const completion of [
    { enabled: true, gates: { commands: ['test'] }, lastGateFailure: { exitText: 'failed' } },
    { enabled: true, gates: { commands: [] }, limits: { maxTurns: 3 }, turnsUsed: 3 },
  ]) {
    const f = await fixture(t, { completion });
    assert.equal((await f.run.done).status, 'failed');
    assert.match((await f.run.done).error, /autonomous verification/);
  }
});

test('cleanup failure still resolves done and removes the worker owner', async (t) => {
  const f = await fixture(t, { cleanupError: true });
  assert.equal((await f.run.done).status, 'failed');
  assert.equal(f.clients[0].closed, true);
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1'), undefined);
});

test('cancel aborts a pending native turn and produces one stopped terminal event', async (t) => {
  const f = await fixture(t, { holdPrompt: true });
  await nextTick();
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1').ownerClientId, 'test-owner');
  await f.run.cancel();
  assert.equal((await f.run.done).status, 'stopped');
  assert(f.commands.some((c) => c.type === 'abort_and_clear_queue'));
  assert.equal(f.events.filter((e) => e.kind === 'done').length, 1);
});

test('transport loss fails the run instead of hanging forever', async (t) => {
  const f = await fixture(t, { holdPrompt: true });
  await nextTick();
  f.clients[0].disconnected(new Error('connection lost'));
  assert.equal((await f.run.done).status, 'failed');
  assert.match((await f.run.done).error, /connection lost/);
});

test('cancellation aborts and revokes live commands before slow bridge cleanup', async (t) => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, { holdPrompt: true, endTurn: () => slow });
  await nextTick();
  const cancelling = f.run.cancel();
  const duplicate = f.run.cancel();
  assert.equal(f.commands.filter((c) => c.type === 'abort_and_clear_queue').length, 1);
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1'), undefined);
  release();
  await Promise.all([cancelling, duplicate]);
  assert.equal((await f.run.done).status, 'stopped');
});
