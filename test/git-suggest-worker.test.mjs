import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function worker(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-suggest-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': '{"type":"module"}',
    'dist/core/auth-storage.js': 'export const AuthStorage = { create: () => ({}) };',
    'dist/core/model-registry.js': `export const ModelRegistry = { create: () => ({
      getAvailable: () => ['helper', 'session'].map(id => ({ provider: 'fixture', id })),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture' })
    }) };`,
    'node_modules/@earendil-works/pi-ai/package.json': '{"type":"module"}',
    'node_modules/@earendil-works/pi-ai/dist/stream.js': `export async function completeSimple(model) {
      return { stopReason: 'stop', content: [{type: 'text', text: 'fix: ' + model.id}] };
    }`,
  };
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  return new Promise((resolveResult, reject) => {
    const child = execFile(process.execPath, [resolve('scripts/git-suggest-worker.mjs')],
      { timeout: 10000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error); else resolveResult(JSON.parse(stdout));
      });
    child.stdin.end(JSON.stringify({ packageDir: root, agentHome: root,
      defaultModel: 'fixture/session', system: 'fixture', user: 'fixture' }));
  });
}
test('commit helper uses the default model path; removed auxiliary input is ignored', async (t) => {
  const result = await worker(t);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'fixture/session');
});
