import { formatMessage as tr } from '../public/i18n-core.js';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './store.mjs';
import { loadPrimeNative } from './prime-native.mjs';

// Removed settings (advanced models, autonomous budgets, quota relay and
// execution/project caps). Studio no longer manages these values and no
// longer reads them for its own features; values already saved keep acting
// in the native engine, which reads settings.json itself. This store only
// detects leftover values and resets (deletes) them on explicit user action.
// settings.json keys: auxiliaryModel, imageModel, providerBackupModel,
// subagentDefaultModel, defaultServiceTier, autonomous.
// Studio data files: quota-fallback.json, budget-settings.json.
export const LEGACY_SETTINGS_KEYS = [
  'auxiliaryModel',
  'imageModel',
  'providerBackupModel',
  'subagentDefaultModel',
  'defaultServiceTier',
  'autonomous',
];
export const LEGACY_STORE_KEYS = ['quotaFallback', 'budgets'];
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function revisionOf(raw) {
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex');
}

// Pure CAS guard, evaluated against the raw content read INSIDE the native
// lock. Exported for unit tests; the reset applies it under lock.
export function assertEngineRevision(raw, expectedRevision) {
  if (expectedRevision === undefined) return revisionOf(raw || '');
  const lockedRevision = revisionOf(raw || '');
  if (lockedRevision !== expectedRevision) {
    const error = new HttpError(
      409,
      tr('server.ces_reglages_ont_change_dans_une_autre_fenetre_rechargez_les_ava'),
    );
    error.currentRevision = lockedRevision;
    throw error;
  }
  return lockedRevision;
}

function hasModelValue(settings, key) {
  const value = settings[key];
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAutonomousValue(settings) {
  const container = record(settings.autonomous) ? settings.autonomous : null;
  return !!container && Object.keys(container).length > 0;
}

// Pure detection over already-read JSON values. Exported for unit tests.
export function detectLegacyItems({ settings = {}, quota = null, budgets = null } = {}) {
  const items = [];
  for (const key of ['auxiliaryModel', 'imageModel', 'providerBackupModel', 'subagentDefaultModel'])
    if (hasModelValue(settings, key)) items.push(key);
  if (typeof settings.defaultServiceTier === 'string' && settings.defaultServiceTier.trim())
    items.push('defaultServiceTier');
  if (hasAutonomousValue(settings)) items.push('autonomous');
  if (
    record(quota) &&
    (quota.automatic === true || (Array.isArray(quota.models) && quota.models.length > 0))
  )
    items.push('quotaFallback');
  if (record(budgets)) {
    const run = record(budgets.run) ? budgets.run : null;
    const projects = record(budgets.projects) ? budgets.projects : {};
    const runHas = !!run && (run.tokens != null || run.estimatedCost != null);
    if (runHas || Object.keys(projects).length > 0) items.push('budgets');
  }
  return items;
}

function readJsonFile(file, maxBytes) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

export function createEngineSettingsStore({ agentHome, dataDir } = {}) {
  if (!agentHome) throw new TypeError('agentHome est requis.');
  const file = join(agentHome, 'settings.json'),
    backupFile = join(agentHome, 'settings.json.prime-studio.bak');
  const quotaFile = dataDir ? join(dataDir, 'quota-fallback.json') : null;
  const budgetsFile = dataDir ? join(dataDir, 'budget-settings.json') : null;
  let writes = Promise.resolve();

  function readRaw() {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES)
        throw new HttpError(500, tr('server.le_fichier_settings_json_est_inaccessible_ou_trop_volumineux'));
      const raw = readFileSync(file, 'utf8');
      const value = JSON.parse(raw);
      if (!record(value)) throw new Error();
      return { raw, settings: value };
    } catch (error) {
      if (error.code === 'ENOENT') return { raw: '', settings: {} };
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide_corrigez_le_a'));
    }
  }

  function snapshot() {
    const { raw, settings } = readRaw();
    const quota = quotaFile ? readJsonFile(quotaFile, 1024 * 1024) : null;
    const budgets = budgetsFile ? readJsonFile(budgetsFile, 1024 * 1024) : null;
    const items = detectLegacyItems({ settings, quota, budgets });
    return { revision: revisionOf(raw), hasLegacy: items.length > 0, items };
  }

  async function get() {
    await writes.catch(() => {});
    return snapshot();
  }

  // Security preflight: same file guards as reads (normal file, no symlink,
  // size cap, valid JSON). Advisory only — never used for CAS. The
  // authoritative re-validation runs inside the native lock below.
  function preflightFile() {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES)
        throw new HttpError(500, tr('server.le_fichier_settings_json_est_inaccessible_ou_trop_volumineux'));
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!record(value)) throw new Error();
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide_corrigez_le_a'));
    }
  }

  async function saveSettings(operation, expectedRevision) {
    const { FileSettingsStorage } = await loadPrimeNative();
    preflightFile();
    // The native writer invokes fn(undefined) before creating agentHome on
    // first write: ensure the directory exists without creating a placeholder
    // settings file (a missing file must keep the null revision).
    mkdirSync(agentHome, { recursive: true, mode: 0o700 });
    // The revision check runs INSIDE the native lock against the locked raw
    // content: a concurrent native or inter-process writer cannot slip between
    // check and write. Same-process callers are already serialized by the
    // writes chain; the lock covers every other writer.
    try {
      new FileSettingsStorage(agentHome, agentHome).withLock('global', (raw) => {
        assertEngineRevision(raw, expectedRevision);
        let settings;
        try {
          settings = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide'));
        }
        if (!record(settings))
          throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide'));
        operation(settings);
        // No backup when there was no previous file: on first write the
        // native callback may run unlocked once, then replay under lock on
        // race. Skipping the backup then keeps the callback side-effect free.
        if (raw !== undefined) {
          let backup;
          try {
            backup = lstatSync(backupFile);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          if (backup && (!backup.isFile() || backup.isSymbolicLink()))
            throw new HttpError(500, tr('server.la_sauvegarde_settings_json_doit_etre_un_fichier_normal'));
          writeFileSync(backupFile, raw || '{}\n', { encoding: 'utf8', mode: 0o600 });
          chmodSync(backupFile, 0o600);
        }
        return JSON.stringify(settings, null, 2) + '\n';
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.impossible_d_enregistrer_settings_json_la_configuration_preceden'));
    }
  }

  function mutate(operation, expectedRevision) {
    const job = writes.catch(() => {}).then(() => saveSettings(operation, expectedRevision));
    writes = job;
    return job;
  }

  // The only write: delete every removed setting, keep everything else.
  async function reset(body = {}) {
    if (!record(body) || Object.keys(body).some((key) => key !== 'revision'))
      throw new HttpError(400, tr('server.reglages_moteur_invalides'));
    const { revision } = body;
    if (
      revision !== undefined &&
      revision !== null &&
      (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
    )
      throw new HttpError(400, tr('server.reglages_moteur_invalides'));
    // No legacy values, no write: resetting must never create a
    // settings.json that did not exist.
    await writes.catch(() => {});
    if (!snapshot().hasLegacy) return get();
    await mutate((settings) => {
      for (const key of LEGACY_SETTINGS_KEYS) delete settings[key];
    }, revision);
    // Studio data files only disappear on this explicit reset; a missing or
    // unreadable file is simply nothing to clear.
    for (const target of [quotaFile, budgetsFile]) {
      if (!target) continue;
      await rm(target, { force: true }).catch(() => {});
    }
    return get();
  }

  return { file, backupFile, get, reset };
}
