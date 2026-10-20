import test from 'node:test';
import assert from 'node:assert/strict';
import { transformDaemonClientEnv } from '../runtime/daemon-stream-hook.mjs';
test('run policy env extends only scoped native allowlist, idempotently', () => {
  const source = 'export const DAEMON_CLIENT_ENV_KEYS = ["HERDR_ENV"];';
  const transformed = transformDaemonClientEnv(source, { required: true });
  assert.ok(transformed.source.includes('PRIME_STUDIO_BUDGET'));
  assert.ok(transformed.source.includes('PRIME_STUDIO_QUOTA_FILE'));
  assert.equal(transformDaemonClientEnv(transformed.source).source, transformed.source);
  assert.throws(() => transformDaemonClientEnv('unsupported', { required: true }));
});

test('run env transform rejects ambiguous and partially patched declarations', () => {
  assert.throws(() => transformDaemonClientEnv('const DAEMON_CLIENT_ENV_KEYS = []; var DAEMON_CLIENT_ENV_KEYS = [];'));
  assert.throws(() => transformDaemonClientEnv('const DAEMON_CLIENT_ENV_KEYS = [/* Studio run policy env. */];', { required: true }));
  const unrelated = 'const USER_KEYS = [];';
  assert.deepEqual(transformDaemonClientEnv(unrelated), { source: unrelated, changed: false });
  assert.match(transformDaemonClientEnv('var DAEMON_CLIENT_ENV_KEYS = [];').source, /PRIME_STUDIO_BUDGET/);
});

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import studioBudget from '../runtime/studio-budget-extension.mjs';

test('each extension captures its run budget before daemon restores ambient env', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-budget-env-'));
  const original = process.env.PRIME_STUDIO_BUDGET;
  t.after(async () => { if (original === undefined) delete process.env.PRIME_STUDIO_BUDGET; else process.env.PRIME_STUDIO_BUDGET = original; await rm(dir, { recursive: true, force: true }); });
  const register = (tokens, file) => {
    const hooks = {};
    process.env.PRIME_STUDIO_BUDGET = JSON.stringify({ tokens, statusFile: file });
    studioBudget({ on: (name, handler) => { hooks[name] = handler; } });
    return hooks;
  };
  const firstFile = join(dir, 'first.json'), secondFile = join(dir, 'second.json');
  const first = register(1, firstFile), second = register(100, secondFile);
  delete process.env.PRIME_STUDIO_BUDGET;
  let aborted = 0;
  const ctx = { abort() { aborted++; } };
  first.message_end({ message: { role: 'assistant', usage: { input: 1 } } }, ctx);
  second.message_end({ message: { role: 'assistant', usage: { input: 1 } } }, ctx);
  await first.before_provider_request({}, ctx);
  await second.before_provider_request({}, ctx);
  assert.equal(aborted, 1);
  assert.equal(JSON.parse(await readFile(firstFile)).status, 'stopped');
  assert.equal(JSON.parse(await readFile(secondFile)).limits.tokens, 100);
});
