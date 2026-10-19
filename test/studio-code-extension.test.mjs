import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDossier, dossierPath, dispatchCode } from '../scripts/studio-code-worker.mjs';

test('dossier is bounded, evidence-only, with commands, pins and guidance pointers', async () => {
  const index = {
    search: async (_project, params) => ({state:'ready',results:params.path === 'package.json' ? [{path:'package.json',startLine:1,endLine:3,text:'"test": "node --test"'}] : [{path:'src/a.js',startLine:2,endLine:4,text:'export function helper() {}'}, {path:'.env.local',startLine:1,endLine:2,text:'DO_NOT_SHOW'}]}),
    map:async (_project,{path}) => ({state:'ready',results:path==='AGENTS.md'?[{path}]:[]}),
  };
  const dossier = await buildDossier({sessionId:'abc',pins:[{path:'src/a.js',startLine:2,endLine:4},{path:'.env'}]}, {q:'helper'}, index, {});
  assert.ok(dossier.text.length<=4500);
  assert.match(dossier.text,/Pinned: src\/a.js:2-4/);
  assert.match(dossier.text,/node --test/);
  assert.match(dossier.text,/AGENTS.md/);
  assert.doesNotMatch(dossier.text,/DO_NOT_SHOW|Pinned: .env/);
});
test('dossier filenames are opaque and cannot traverse', () => {
  const path=dossierPath({dataDir:'data',projectId:'abc',sessionId:'../../other'});
  assert.match(path,/[a-f0-9]{64}\.json$/);
  assert.throws(()=>dossierPath({dataDir:'data',projectId:'../bad',sessionId:'abc'}));
});
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
  const config={dataDir,projectPath,projectId,sessionId:'session',enabled:true,pins:[{path:'visible.js'}]};
  const request=(action='search',params={q:'uniqueLiveFixture'})=>dispatchCode({config,action,params});
  const settings=join(dataDir,'code-index',projectId,'settings.json');
  try {
    assert.ok((await request()).results.length);
    await writeFile(settings,JSON.stringify({enabled:true,exclusions:['visible.js'],pins:[{path:'visible.js'}]}));
    assert.deepEqual((await request()).results,[]);
    assert.deepEqual((await request('symbols',{symbol:'uniqueLiveFixture'})).results,[]);
    assert.deepEqual((await request('map',{path:'visible.js'})).results,[]);
    assert.doesNotMatch((await request('dossier',{q:'uniqueLiveFixture'})).text,/visible.js/);
    await writeFile(settings,JSON.stringify({enabled:true,exclusions:[],sessions:{session:false}}));
    assert.equal((await request()).state,'disabled');
    await writeFile(settings,JSON.stringify({enabled:false}));
    assert.equal((await request()).state,'disabled');
  } finally { await rm(root,{recursive:true,force:true}); }
});
