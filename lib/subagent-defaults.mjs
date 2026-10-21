import { formatMessage as tr } from '../public/i18n-core.js';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './store.mjs';
import { readPolicyFile, projectKey, validPolicy, effectivePolicy } from '../runtime/subagent-policy.mjs';

export function createSubagentDefaultsStore({ dataDir }) {
  const file = join(dataDir, 'subagent-defaults.json');
  let writes = Promise.resolve();
  function read() {
    try {
      return readPolicyFile(file);
    } catch (error) {
      throw new HttpError(500, error.message);
    }
  }
  async function get(cwd) {
    await writes.catch(() => {});
    const data = read();
    const project = cwd ? (data.projects[projectKey(cwd)] ?? null) : null;
    return { revision: data.revision, global: data.global, project, effective: effectivePolicy(data.global, project) };
  }
  async function set({ cwd, policy, revision }) {
    if (typeof revision !== 'string' || (policy === null ? !cwd : !validPolicy(policy)))
      throw new HttpError(400, tr('server.reglages_des_sous_agents_invalides'));
    const operation = writes
      .catch(() => {})
      .then(async () => {
        const data = read();
        if (data.revision !== revision)
          throw new HttpError(
            409,
            tr('server.ces_reglages_ont_change_dans_une_autre_fenetre_rechargez_les_ava'),
          );
        // Per-role routing was removed in 4.4.1: legacy `roles` are accepted
        // by validPolicy but stripped on write so old role settings never apply.
        const { roles: _ignoredRoles, ...cleanPolicy } = policy || {};
        if (cwd) {
          if (policy === null) delete data.projects[projectKey(cwd)];
          else data.projects[projectKey(cwd)] = { ...cleanPolicy };
        } else if (policy !== null) data.global = { ...cleanPolicy };
        data.revision = randomUUID();
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    writes = operation;
    await operation;
    return get(cwd);
  }
  return { file, get, set };
}
