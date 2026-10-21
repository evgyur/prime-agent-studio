import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, cwdKey } from './store.mjs';

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function normalizeBudgetLimits(value = {}) {
  if (!object(value) || Object.keys(value).some((key) => !['tokens', 'estimatedCost'].includes(key)))
    throw new HttpError(400, 'Invalid budget limits');
  const result = { tokens: null, estimatedCost: null };
  for (const key of Object.keys(result)) {
    const n = value[key];
    if (n == null) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || (key === 'tokens' && !Number.isSafeInteger(n)))
      throw new HttpError(400, 'Budget limits must be positive finite numbers (tokens: integer)');
    result[key] = n;
  }
  return result;
}
export function readBudgetStatus(budget) {
  if (!budget?.statusFile) return null;
  try { return JSON.parse(readFileSync(budget.statusFile, 'utf8')); } catch { return null; }
}
export function createBudgetSettings({ dataDir }) {
  const file = join(dataDir, 'budget-settings.json');
  let pending = Promise.resolve();
  async function read() {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe budget settings file');
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.period !== 'day' ||
          !object(value.projects) || Object.keys(value).some((key) => !['revision', 'period', 'run', 'projects'].includes(key)))
        throw new Error('Invalid persisted budget settings');
      const projects = {};
      for (const [cwd, limits] of Object.entries(value.projects)) {
        if (!isAbsolute(cwd)) throw new Error('Invalid persisted budget project');
        projects[cwdKey(cwd)] = normalizeBudgetLimits(limits);
      }
      return { revision: value.revision, period: 'day', run: normalizeBudgetLimits(value.run), projects };
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw new HttpError(409, 'Budget settings cannot be read safely');
      return { revision: 0, period: 'day', run: normalizeBudgetLimits(), projects: {} };
    }
  }
  function write(value) {
    const operation = pending.then(async () => {
      if (!object(value) || Object.keys(value).some((key) => !['revision', 'period', 'run', 'projects'].includes(key)) || value.period !== 'day' || !object(value.projects))
        throw new HttpError(400, 'Invalid budget settings');
      const current = await read();
      if (value.revision !== current.revision) throw new HttpError(409, 'Budget revision conflict');
      const projects = {};
      for (const [cwd, limits] of Object.entries(value.projects)) {
        if (!isAbsolute(cwd)) throw new HttpError(400, 'Budget project path must be absolute');
        projects[cwdKey(cwd)] = normalizeBudgetLimits(limits);
      }
      const next = { revision: current.revision + 1, period: 'day', run: normalizeBudgetLimits(value.run), projects };
      await mkdir(dataDir, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, file);
      return next;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  async function forRun(cwd, override) {
    const settings = await read();
    const run = normalizeBudgetLimits(override ?? settings.run);
    const key = cwdKey(cwd);
    const project = normalizeBudgetLimits(settings.projects[key]);
    if (![run.tokens, run.estimatedCost, project.tokens, project.estimatedCost].some(Boolean)) return null;
    const ledgerDir = join(dataDir, 'budget-usage');
    await mkdir(ledgerDir, { recursive: true });
    const runId = randomUUID();
    return { ...run, project, ledgerDir, projectKey: createHash('sha256').update(key).digest('hex'), runId,
      statusFile: join(ledgerDir, `${runId}.status.json`) };
  }
  return { read, write, forRun };
}
