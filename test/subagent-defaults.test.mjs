import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createSubagentDefaultsStore } from '../lib/subagent-defaults.mjs';
import { applySubagentDefaults, subagentInstruction, policyFor } from '../runtime/subagent-policy.mjs';
import { transformSubagentSession } from '../runtime/subagent-hook.mjs';
import { discoverCli, createAgentRuntime } from '../lib/agent.mjs';
import { reasoningMode } from '../public/reasoning.js';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'prime-subagent-policy-'));
  t.after(async () => {
    assert.equal(dirname(dataDir), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    store: createSubagentDefaultsStore({ dataDir }),
    cwd: join(dataDir, 'project'),
    other: join(dataDir, 'other'),
  };
}
test('subagent defaults preserve explicit choices, use project overrides and reload atomically', async (t) => {
  const { store, cwd, other } = await fixture(t);
  assert.deepEqual(applySubagentDefaults(cwd, { name: 'child' }, store.file), { name: 'child' });
  assert.equal(subagentInstruction(cwd, store.file), '');
  let state = await store.set({ revision: '', policy: { model: 'fixture/default', thinking: 'high' } });
  assert.deepEqual(applySubagentDefaults(cwd, { name: 'child' }, store.file), {
    name: 'child',
    model: 'fixture/default',
    thinking: 'high',
  });
  assert.deepEqual(applySubagentDefaults(cwd, { model: 'fixture/explicit', thinking: 'off' }, store.file), {
    model: 'fixture/explicit',
    thinking: 'off',
  });
  assert.equal(applySubagentDefaults(cwd, { thinking: null }, store.file).thinking, null);
  assert.match(subagentInstruction(cwd, store.file), /fixture\/default[\s\S]*high/);
  state = await store.set({ cwd, revision: state.revision, policy: { model: '', thinking: 'low' } });
  assert.deepEqual(policyFor(cwd, store.file), { model: '', thinking: 'low' });
  assert.deepEqual(applySubagentDefaults(cwd, { name: 'native-default' }, store.file), {
    name: 'native-default',
    thinking: 'low',
  });
  assert.match(
    subagentInstruction(cwd, store.file),
    /omit the model argument to use the native default model/,
  );
  assert.equal(policyFor(other, store.file).model, 'fixture/default');
  state = await store.set({ cwd, revision: state.revision, policy: null });
  assert.equal(policyFor(cwd, store.file).thinking, 'high');
  assert.equal((await store.get(cwd)).project, null);
});
test('stale saves cannot overwrite another window; malformed configuration is never silently replaced', async (t) => {
  const { store } = await fixture(t);
  const saves = await Promise.allSettled([
    store.set({ revision: '', policy: { model: '', thinking: 'high' } }),
    store.set({ revision: '', policy: { model: '', thinking: 'low' } }),
  ]);
  assert.equal(saves.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(saves.find((r) => r.status === 'rejected').reason.status, 409);
  await assert.rejects(store.set({ revision: '', policy: { model: 'bad\nmodel', thinking: 'high' } }), {
    status: 400,
  });
  await writeFile(store.file, '{invalid');
  await assert.rejects(store.get(), /illisibles/);
  await assert.rejects(store.set({ revision: '', policy: { model: '', thinking: '' } }), /illisibles/);
  assert.equal(await readFile(store.file, 'utf8'), '{invalid');
});
test('installed bundled and unbundled Prime Agent support the scoped adapter; changed versions fail explicitly', async () => {
  const cli = discoverCli();
  assert.ok(cli?.packageDir);
  const source = await readFile(join(cli.packageDir, 'dist/core/agent-session.js'), 'utf8');
  const result = transformSubagentSession(source, { required: true });
  assert.ok(result.changed);
  assert.match(result.source, /thinkingLevel: child\?\.thinkingLevel/);
  assert.throws(() =>
    transformSubagentSession(
      source.replace('const executionPolicy = firstTurn.payload.executionPolicy;', 'changed();'),
    ),
  );
  assert.equal(transformSubagentSession('export const unrelated = true;').changed, false);
  let patched = 0;
  for (const name of await readdir(join(cli.packageDir, 'dist/bundle'))) {
    if (!name.endsWith('.js')) continue;
    if (transformSubagentSession(await readFile(join(cli.packageDir, 'dist/bundle', name), 'utf8')).changed)
      patched++;
  }
  assert.equal(patched, 1);
});
test('reasoning preference migrates old toggles while new installations start with a preview', () => {
  assert.equal(reasoningMode({}), 'preview');
  assert.equal(reasoningMode({ showReasoning: true }), 'expanded');
  assert.equal(reasoningMode({ showReasoning: false }), 'hidden');
  assert.equal(reasoningMode({ reasoningMode: 'preview', showReasoning: false }), 'preview');
});

test('thinking choices use the native capability map and preserve it through model name overrides', async (t) => {
  const { store } = await fixture(t);
  const agentHome = dirname(store.file);
  await writeFile(
    join(agentHome, 'models.json'),
    JSON.stringify({
      providers: {
        openrouter: {
          apiKey: 'isolated-openrouter-fixture-key',
          modelOverrides: {
            'minimax/minimax-m3': {
              name: 'After',
              reasoning: true,
              thinkingLevelMap: {
                minimal: 'minimal',
                low: 'low',
                medium: 'medium',
                high: null,
                xhigh: 'very_high',
                max: 'maximum',
              },
            },
          },
        },
      },
    }),
  );
  const runtime = createAgentRuntime({
    agentHome,
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: agentHome,
      USERPROFILE: agentHome,
      APPDATA: agentHome,
      PI_OFFLINE: '1',
    },
    modelAvailability: {
      async apply(models) {
        return { models, refreshing: false };
      },
      close() {},
    },
  });
  t.after(() => runtime.close());
  const model = (await runtime.getModels()).models.find((m) => m.id === 'openrouter/minimax/minimax-m3');
  assert.equal(model.name, 'After');
  assert.deepEqual(model.thinkingLevels, ['off', 'minimal', 'low', 'medium', 'xhigh', 'max']);
  assert.equal('thinkingLevelMap' in model, false);
});

test('legacy role settings are accepted but never applied; role argument is stripped', async (t) => {
  const { store, cwd } = await fixture(t);
  let state = await store.set({ revision: '', policy: {
    model: 'fixture/global', thinking: 'high',
    roles: { explore: { model: 'fixture/explore', thinking: 'low' }, review: { thinking: 'max' } },
  } });
  // Legacy roles are stripped on write so old role settings never apply.
  assert.deepEqual(state.global, { model: 'fixture/global', thinking: 'high' });
  assert.deepEqual(state.effective, { model: 'fixture/global', thinking: 'high' });
  state = await store.set({ cwd, revision: state.revision, policy: {
    model: 'fixture/project', thinking: 'medium', roles: { explore: { thinking: 'off' } },
  } });
  assert.deepEqual(state.effective, { model: 'fixture/project', thinking: 'medium' });
  // Compatibility: a stale `role` kwarg is ignored silently.
  assert.deepEqual(applySubagentDefaults(cwd, { role: 'explore', name: 'scan' }, store.file), {
    model: 'fixture/project', thinking: 'medium', name: 'scan',
  });
  assert.deepEqual(applySubagentDefaults(cwd, { role: 'typo', name: 'scan' }, store.file), {
    model: 'fixture/project', thinking: 'medium', name: 'scan',
  });
  assert.deepEqual(applySubagentDefaults(cwd, { role: null, name: 'scan' }, store.file), {
    model: 'fixture/project', thinking: 'medium', name: 'scan',
  });
  assert.deepEqual(applySubagentDefaults(cwd, { role: 'review', model: 'fixture/explicit', thinking: null }, store.file), {
    model: 'fixture/explicit', thinking: null,
  });
  assert.doesNotMatch(subagentInstruction(cwd, store.file), /role/);
  // Old files already containing roles stay readable but roles never apply.
  await writeFile(store.file, JSON.stringify({
    version: 1, revision: state.revision,
    global: { model: 'fixture/global', thinking: 'high', roles: { explore: { model: 'fixture/explore' } } },
    projects: {},
  }));
  assert.deepEqual(policyFor(cwd, store.file), { model: 'fixture/global', thinking: 'high' });
  assert.deepEqual(applySubagentDefaults(cwd, { role: 'explore', name: 'scan' }, store.file), {
    model: 'fixture/global', thinking: 'high', name: 'scan',
  });
});
test('general model/thinking stay validated while legacy roles are ignored', async (t) => {
  const { store, cwd } = await fixture(t);
  for (const roles of [null, []]) {
    await assert.rejects(store.set({ revision: '', policy: { model: '', thinking: '', roles } }), { status: 400 });
  }
  // Legacy role contents are accepted but stripped on write.
  for (const roles of [{ typo: {} }, { explore: null }, { explore: { model: 1 } },
    { explore: { thinking: 'invalid' } }, { explore: { extra: true } }]) {
    const state = await store.set({ revision: (await store.get(cwd)).revision, policy: { model: '', thinking: '', roles } });
    assert.deepEqual(state.global, { model: '', thinking: '' });
  }
  await assert.rejects(store.set({ revision: '', policy: { model: 'bad\nmodel', thinking: 'high' } }), { status: 400 });
  await assert.rejects(store.set({ revision: '', policy: { model: '', thinking: 'invalid' } }), { status: 400 });
});
