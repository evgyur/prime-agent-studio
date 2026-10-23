import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEngineSettingsStore,
  assertEngineRevision,
  detectLegacyItems,
  LEGACY_SETTINGS_KEYS,
  LEGACY_STORE_KEYS,
} from '../lib/engine-settings.mjs';

async function fixture(t, settings) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-legacy-settings-'));
  const agentHome = join(root, 'agent');
  const dataDir = join(root, 'data');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(agentHome, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  if (settings !== undefined) await writeFile(join(agentHome, 'settings.json'), settings, 'utf8');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { agentHome, dataDir, store: createEngineSettingsStore({ agentHome, dataDir }) };
}

test('starts clean when nothing was ever saved', async (t) => {
  const { store } = await fixture(t);
  const state = await store.get();
  assert.equal(state.revision, null);
  assert.equal(state.hasLegacy, false);
  assert.deepEqual(state.items, []);
});

test('unrelated settings never count as legacy', async (t) => {
  const { store } = await fixture(t, JSON.stringify({ theme: 'light', defaultModel: 'openai/a' }));
  const state = await store.get();
  assert.equal(state.hasLegacy, false);
  assert.deepEqual(state.items, []);
});

test('every removed settings.json key is detected', async (t) => {
  const { store } = await fixture(t, JSON.stringify({
    theme: 'light',
    auxiliaryModel: 'openai/gpt-5.4',
    imageModel: 'openai/vision',
    providerBackupModel: 'openai/fallback',
    subagentDefaultModel: 'openai/sub',
    defaultServiceTier: 'priority',
    autonomous: { maxTurns: 6, maxTokens: 'unlimited' },
  }));
  const state = await store.get();
  assert.equal(state.hasLegacy, true);
  assert.deepEqual(state.items, [
    'auxiliaryModel',
    'imageModel',
    'providerBackupModel',
    'subagentDefaultModel',
    'defaultServiceTier',
    'autonomous',
  ]);
});

test('blank and empty values do not count as legacy', () => {
  assert.deepEqual(
    detectLegacyItems({ settings: {
      auxiliaryModel: '  ',
      providerBackupModel: '',
      defaultServiceTier: '',
      autonomous: {},
      theme: 'light',
    } }),
    [],
  );
  assert.deepEqual(detectLegacyItems({}), []);
  assert.deepEqual(detectLegacyItems({ settings: null, quota: null, budgets: null }), []);
});

test('quota fallback and budget files count as legacy only when they hold values', () => {
  assert.deepEqual(detectLegacyItems({ quota: { revision: 0, automatic: false, models: [] } }), []);
  assert.deepEqual(
    detectLegacyItems({ quota: { revision: 1, automatic: true, models: [] } }),
    ['quotaFallback'],
  );
  assert.deepEqual(
    detectLegacyItems({ quota: { revision: 1, automatic: false, models: ['openai/a'] } }),
    ['quotaFallback'],
  );
  assert.deepEqual(
    detectLegacyItems({ budgets: { revision: 0, period: 'day', run: { tokens: null, estimatedCost: null }, projects: {} } }),
    [],
  );
  assert.deepEqual(
    detectLegacyItems({ budgets: { revision: 1, period: 'day', run: { tokens: 1000, estimatedCost: null }, projects: {} } }),
    ['budgets'],
  );
  assert.deepEqual(
    detectLegacyItems({ budgets: { revision: 1, period: 'day', run: { tokens: null, estimatedCost: null }, projects: { '/tmp/x': { tokens: 5 } } } }),
    ['budgets'],
  );
});

test('read failures stay unreadable instead of looking clean', async (t) => {
  const { store, dataDir } = await fixture(t, JSON.stringify({ auxiliaryModel: 'openai/a' }));
  await writeFile(join(dataDir, 'quota-fallback.json'), 'not json', 'utf8');
  const state = await store.get();
  assert.deepEqual(state.items, ['auxiliaryModel']);
});

test('reset deletes every legacy value and keeps unrelated keys', async (t) => {
  const { agentHome, dataDir, store } = await fixture(t, JSON.stringify({
    theme: 'light',
    auxiliaryModel: 'openai/gpt-5.4',
    imageModel: 'openai/vision',
    providerBackupModel: 'openai/fallback',
    subagentDefaultModel: 'openai/sub',
    defaultServiceTier: 'flex',
    autonomous: { maxTurns: 6 },
  }));
  await writeFile(join(dataDir, 'quota-fallback.json'), JSON.stringify({ revision: 1, automatic: true, models: ['openai/a'] }), 'utf8');
  await writeFile(join(dataDir, 'budget-settings.json'), JSON.stringify({ revision: 1, period: 'day', run: { tokens: 10, estimatedCost: null }, projects: {} }), 'utf8');
  const before = await store.get();
  assert.equal(before.hasLegacy, true);
  const after = await store.reset({ revision: before.revision });
  assert.equal(after.hasLegacy, false);
  assert.deepEqual(after.items, []);
  const raw = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.deepEqual(raw, { theme: 'light' });
  for (const key of LEGACY_SETTINGS_KEYS) assert.equal(key in raw, false);
  for (const name of ['quota-fallback.json', 'budget-settings.json']) {
    await assert.rejects(readFile(join(dataDir, name), 'utf8'), (error) => {
      assert.equal(error.code, 'ENOENT');
      return true;
    });
  }
  assert.equal((await store.get()).hasLegacy, false);
});

test('reset without legacy values writes nothing', async (t) => {
  const { agentHome, store } = await fixture(t, JSON.stringify({ theme: 'light' }));
  const before = await store.get();
  assert.equal(before.hasLegacy, false);
  const after = await store.reset({ revision: before.revision });
  assert.equal(after.hasLegacy, false);
  assert.deepEqual(JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8')), { theme: 'light' });
  const missing = await fixture(t);
  assert.equal((await missing.store.reset({})).hasLegacy, false);
  await assert.rejects(readFile(join(missing.agentHome, 'settings.json'), 'utf8'), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('reset is revision protected and rejects unknown keys', async (t) => {
  const { store } = await fixture(t, JSON.stringify({ theme: 'light', auxiliaryModel: 'openai/a' }));
  const before = await store.get();
  await assert.rejects(store.reset({ revision: before.revision, auxiliaryModel: 'openai/b' }), { status: 400 });
  await assert.rejects(store.reset({ revision: 'x' }), { status: 400 });
  await assert.rejects(store.reset({ revision: before.revision.slice(0, -1) + '0' }), { status: 409 });
  await assert.rejects(store.reset(null), { status: 400 });
  assert.equal((await store.get()).hasLegacy, true);
});

test('reset keeps the same safe-write rules: backup, atomic write and permissions', async (t) => {
  const { agentHome, store } = await fixture(t, JSON.stringify({ theme: 'light', auxiliaryModel: 'openai/a' }));
  const before = await store.get();
  await store.reset({ revision: before.revision });
  const backup = await readFile(join(agentHome, 'settings.json.prime-studio.bak'), 'utf8');
  assert.ok(backup.includes('auxiliaryModel'));
  const { stat } = await import('node:fs/promises');
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(agentHome, 'settings.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(agentHome, 'settings.json.prime-studio.bak'))).mode & 0o777, 0o600);
  }
  const reread = await store.get();
  assert.match(reread.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(reread.revision, before.revision);
});

test('assertEngineRevision guards raw content read under lock', () => {
  assert.equal(assertEngineRevision('', undefined), null);
  assert.equal(assertEngineRevision(undefined, undefined), null);
  const revisionOfRaw = (raw) => assertEngineRevision(raw, undefined);
  const emptyRev = revisionOfRaw('{}');
  assert.match(emptyRev, /^[a-f0-9]{64}$/);
  assert.equal(assertEngineRevision('{}', emptyRev), emptyRev);
  const rev = revisionOfRaw('{"a":1}');
  assert.match(rev, /^[a-f0-9]{64}$/);
  assert.equal(assertEngineRevision('{"a":1}', rev), rev);
  assert.throws(
    () => assertEngineRevision('{"a":2}', rev),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.currentRevision, revisionOfRaw('{"a":2}'));
      return true;
    },
  );
  assert.throws(
    () => assertEngineRevision('', rev),
    (error) => error.status === 409,
  );
  assert.throws(
    () => assertEngineRevision('{"a":1}', null),
    (error) => error.status === 409,
  );
  assert.equal(assertEngineRevision('', null), null);
});

test('malformed settings reject reads and resets without overwrite', async (t) => {
  const broken = '{ "auxiliaryModel": ';
  const { agentHome, store } = await fixture(t, broken);
  await assert.rejects(store.get(), /JSON invalide/);
  await assert.rejects(store.reset({}), /JSON invalide/);
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), broken);
  await assert.rejects(readFile(join(agentHome, 'settings.json.prime-studio.bak'), 'utf8'), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('symlinked settings reject reads and resets', async (t) => {
  const { agentHome, store } = await fixture(t);
  const target = join(agentHome, 'real-settings.json');
  await writeFile(target, JSON.stringify({ auxiliaryModel: 'openai/a' }), 'utf8');
  try {
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, join(agentHome, 'settings.json'), 'file');
  } catch (error) {
    t.skip(`symlinks need privileges on this machine: ${error.code || error.message}`);
    return;
  }
  await assert.rejects(store.get(), (error) => error.status === 500);
  await assert.rejects(store.reset({}), (error) => error.status === 500);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).auxiliaryModel, 'openai/a');
});

test('removed keys stay exported for the reset contract', () => {
  assert.deepEqual(LEGACY_SETTINGS_KEYS, [
    'auxiliaryModel',
    'imageModel',
    'providerBackupModel',
    'subagentDefaultModel',
    'defaultServiceTier',
    'autonomous',
  ]);
  assert.deepEqual(LEGACY_STORE_KEYS, ['quotaFallback', 'budgets']);
});
