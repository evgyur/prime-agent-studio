import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCode } from '../scripts/studio-code-worker.mjs';

test('disabled or unknown requests fail before opening an index', async () => {
  await assert.rejects(dispatchCode({config:{enabled:false},action:'search'}),/disabled/);
  await assert.rejects(dispatchCode({config:{enabled:true,projectId:'abc',projectPath:'x',dataDir:'y'},action:'delete'}),/Unknown/);
});

test('live exclusions and project/session switches apply before index refresh', { timeout: 20000 }, async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { createCodeIndex } = await import('../lib/code-index.mjs');
  const root = await mkdtemp(join(tmpdir(), 'studio-code-live-'));
  const projectPath=join(root,'project'), dataDir=join(root,'studio-data');
  await mkdir(projectPath); await mkdir(dataDir);
  execFileSync('git',['init',projectPath],{timeout:5000,stdio:'ignore',windowsHide:true});
  await writeFile(join(projectPath,'visible.js'),'export function uniqueLiveFixture() {}');
  const projectId='a'.repeat(64), project={metricsId:projectId,path:projectPath};
  const writer=createCodeIndex({dataDir});
  try { assert.equal((await writer.refresh(project)).state,'ready'); } finally { await writer.close(); }
  const config={dataDir,projectPath,projectId,sessionId:'session',enabled:true};
  const request=(action='search',params={q:'uniqueLiveFixture'})=>dispatchCode({config,action,params});
  const settings=join(dataDir,'code-index',projectId,'settings.json');
  try {
    assert.ok((await request()).results.length);
    await writeFile(settings,JSON.stringify({enabled:true,exclusions:['visible.js']}));
    assert.deepEqual((await request()).results,[]);
    assert.deepEqual((await request('symbols',{symbol:'uniqueLiveFixture'})).results,[]);
    assert.deepEqual((await request('map',{path:'visible.js'})).results,[]);
    await writeFile(settings,JSON.stringify({enabled:true,exclusions:[],sessions:{session:false}}));
    assert.equal((await request()).state,'disabled');
    await writeFile(settings,JSON.stringify({enabled:false}));
    assert.equal((await request()).state,'disabled');
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('native code tool descriptions stay short and exact-first', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../runtime/studio-code-extension.mjs', import.meta.url), 'utf8');
  for (const name of ['studio_code_search', 'studio_code_symbols', 'studio_code_map']) {
    const declaration = source.split('\n').find((line) => line.includes(`['${name}',`));
    assert.ok(declaration && declaration.length <= 300, name);
  }
  assert.match(source, /Exact literal search/);
  assert.match(source, /stale:true, re-read source/);
  assert.doesNotMatch(source, /studio_code_dossier/);
});

test('unknown code operations fail without touching the index', async () => {
  await assert.rejects(dispatchCode({ config: { enabled: true, projectId: 'abc', projectPath: 'x', dataDir: 'y' }, action: 'dossier', params: {} }), /Unknown/);
});
