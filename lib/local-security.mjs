import { readFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = fileURLToPath(new URL('..', import.meta.url));

// Only a build-time profile activates the local security fork. Environment
// overrides must not silently replace its engine or reuse the shared CLI home.
export async function localSecurityEnvironment(dataRoot, env = process.env, root = studioRoot) {
  let profile;
  try {
    profile = JSON.parse(await readFile(join(root, 'security-profile.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...env };
    throw new Error('security_profile_invalid');
  }
  if (profile.schema !== 1 || !/^[a-f0-9]{64}$/.test(profile.engineBuildId || ''))
    throw new Error('security_profile_invalid');
  const engine = join(root, '.hardened', 'engine');
  const pkg = JSON.parse(await readFile(join(engine, 'package.json'), 'utf8'));
  if (pkg.name !== 'prime-agent' || pkg.primeStudioHardening !== profile.engineBuildId)
    throw new Error('security_engine_mismatch');
  const cli = join(engine, 'dist', 'bundle', 'cli.js');
  for (const path of [
    cli,
    join(dirname(cli), 'cli-node.js'),
    join(engine, 'dist/utils/auth-protection.js'),
  ]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('security_engine_invalid');
  }
  const agentHome = join(dataRoot, 'agent-secure');
  return {
    ...env,
    PRIME_AGENT_CLI: cli,
    PRIME_AGENT_AUTH_PROTECTION: 'dpapi',
    PRIME_AGENT_CODING_AGENT_DIR: agentHome,
    PI_CODING_AGENT_DIR: agentHome,
    PRIME_AGENT_SESSION_DIR: join(agentHome, 'sessions'),
  };
}
