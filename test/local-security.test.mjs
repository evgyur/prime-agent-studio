import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSecurityEnvironment } from '../lib/local-security.mjs';

test('hardened profile pins engine and isolates encrypted credentials from shared CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const env = {
    PRIME_AGENT_CLI: 'old-engine',
    PRIME_AGENT_CODING_AGENT_DIR: 'shared',
    PRIME_AGENT_AUTH_PROTECTION: 'none',
    PRIME_AGENT_SESSION_DIR: 'shared-sessions',
    PATH: 'preserved',
  };
  assert.deepEqual(await localSecurityEnvironment(data, env, root), env);
  const id = 'a'.repeat(64);
  const engine = join(root, '.hardened/engine');
  await mkdir(join(engine, 'dist/bundle'), { recursive: true });
  await mkdir(join(engine, 'dist/utils'), { recursive: true });
  await writeFile(join(root, 'security-profile.json'), JSON.stringify({ schema: 1, engineBuildId: id }));
  await writeFile(
    join(engine, 'package.json'),
    JSON.stringify({ name: 'prime-agent', primeStudioHardening: id }),
  );
  for (const name of ['bundle/cli.js', 'bundle/cli-node.js', 'utils/auth-protection.js'])
    await writeFile(join(engine, 'dist', name), '// fixture');
  const secured = await localSecurityEnvironment(data, env, root);
  assert.equal(secured.PRIME_AGENT_AUTH_PROTECTION, 'dpapi');
  assert.equal(secured.PRIME_AGENT_CODING_AGENT_DIR, join(data, 'agent-secure'));
  assert.equal(secured.PRIME_AGENT_SESSION_DIR, join(data, 'agent-secure/sessions'));
  assert.equal(secured.PRIME_AGENT_CLI, join(engine, 'dist/bundle/cli.js'));
  assert.equal(secured.PATH, env.PATH);
  assert.equal(env.PRIME_AGENT_CLI, 'old-engine');
  await writeFile(
    join(engine, 'package.json'),
    JSON.stringify({ name: 'prime-agent', primeStudioHardening: 'unpatched' }),
  );
  await assert.rejects(localSecurityEnvironment(data, env, root), /security_engine_mismatch/);
  await writeFile(join(root, 'security-profile.json'), '{');
  await assert.rejects(localSecurityEnvironment(data, env, root), /security_profile_invalid/);
});
