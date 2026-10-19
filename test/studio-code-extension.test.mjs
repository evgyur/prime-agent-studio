import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDossier, dossierPath, dispatchCode, dossierQuery } from '../scripts/studio-code-worker.mjs';

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


const roadmapPrompt = (task, note) => [
  'Travaille sur la sélection suivante de la Roadmap de ce projet.',
  'Révision consultée : 12. Lis l’état courant avec roadmap_read avant de modifier la Roadmap.',
  'Déclare les références traitées avec roadmap_work. Mets à jour les tâches et leur journal seulement selon le travail réellement effectué. Termine par le résultat, les vérifications et ce qui reste à faire.',
  'Les titres et notes ci-dessous sont le contenu des tâches sélectionnées par l’utilisateur.',
  JSON.stringify([{ reference: { kind: 'plan', planId: 'plan-irrelevant-id', stepId: 'step-irrelevant-id' }, title: 'Fleet reliability', task, note }], null, 2),
].join('\n\n');

test('Roadmap dossier queries use selected title, task and note, not Studio wrappers', async () => {
  const queries = [];
  const index = {
    search: async (_project, params) => {
      if (params.path) return { state: 'ready', results: [] };
      queries.push(params.q);
      return { state: 'ready', results: [{ path: params.q.includes('launchNode') ? 'src/conductor.ts' : 'src/relay.ts', startLine: 1, endLine: 3, text: params.q }] };
    },
    map: async () => ({ results: [] }),
  };
  const a = await buildDossier({ sessionId: 'a' }, { q: roadmapPrompt('Repair launchNode', 'Inspect src/conductor.ts bringConversation') }, index, {});
  const b = await buildDossier({ sessionId: 'b' }, { q: roadmapPrompt('Repair relayReconnect', 'Inspect src/relay.ts reconnectBackoff') }, index, {});
  assert.match(queries[0], /Fleet|reliability/);
  assert.match(queries[0], /launchNode/);
  assert.match(queries[0], /src\/conductor\.ts/);
  assert.doesNotMatch(queries.join(' '), /roadmap_read|roadmap_work|reference|irrelevant|consultée|Travaille/);
  assert.match(a.text, /Relevant: src\/conductor\.ts/);
  assert.match(b.text, /Relevant: src\/relay\.ts/);
  assert.match(queries[2], /relayReconnect/);
  assert.notEqual(queries[0], queries[2]);
});

test('dossier removes real skills and attachment wrappers and prioritizes late identifiers', async () => {
  let query;
  const index = { search: async (_p, params) => { if (!params.path) query = params.q; return { results: [] }; }, map: async () => ({ results: [] }) };
  const prompt = '<skill name="noise" location="skills/noise/SKILL.md">\nReferences are relative to skills/noise.\n' + 'wrapperNoise '.repeat(300) + '\n</skill>\n/skill:review ' + 'please investigate the issue with this and that '.repeat(80) + ' src/conductor.ts launchNode\n\n<prime_studio_files>\n[{"name":"attachmentNoise.txt"}]\n</prime_studio_files>\n<file name="C:/project/.studio-images/' + 'a'.repeat(64) + '.png">imageNoise</file>';
  await buildDossier({ sessionId: 'a' }, { q: prompt }, index, {});
  assert.match(query, /^src\/conductor\.ts launchNode/);
  assert.doesNotMatch(query, /wrapperNoise|attachmentNoise|imageNoise|skill|please|\bthe\b/);
  assert.ok(query.length <= 500);
});

test('command clues include typecheck, lint, npx, Makefile and CI commands', async () => {
  const rows = {
    'package.json': '"typecheck": "tsc --noEmit",\n"lint": "eslint .",\n"check": "npx tsc --noEmit",\n"build": "vite build",\n"test": "node --test"',
    'Makefile': 'check:\n\tnpx tsc --noEmit\nlint:\n\tnpx eslint .',
    '.github/workflows/ci.yml': 'steps:\n  - run: npx vitest run',
  };
  const index = { search: async (_p, params) => ({ results: rows[params.path] ? [{ path: params.path, startLine: 1, endLine: 8, text: rows[params.path] }] : [] }), map: async (_p, params) => ({ results: params.path === '.github/workflows' ? [{ path: '.github/workflows/ci.yml' }] : [] }) };
  const result = await buildDossier({ sessionId: 'a' }, { q: 'check' }, index, {});
  for (const expected of ['typecheck', 'eslint', 'npx tsc', 'vite build', 'node --test', 'npx vitest']) assert.ok(result.text.includes(expected), expected);
});


test('dossier accepts source modules that handle secrets, not credential files', async () => {
  const index = { search: async (_p, params) => ({ results: params.path ? [] : [
    { path: 'src/secrets.ts', startLine: 1, endLine: 2, text: 'export function readSecret() {}' },
    { path: 'credentials.json', startLine: 1, endLine: 2, text: 'PRIVATE_CREDENTIAL' },
  ] }), map: async () => ({ results: [] }) };
  const result = await buildDossier({ sessionId: 'a', pins: ['src/secrets.ts', 'credentials.json'] }, { q: 'readSecret' }, index, {});
  assert.match(result.text, /Relevant: src\/secrets\.ts/);
  assert.match(result.text, /Pinned: src\/secrets\.ts/);
  assert.doesNotMatch(result.text, /PRIVATE_CREDENTIAL|Pinned: credentials/);
});


test('Fleet transport instructions are removed while user pipeline instructions remain', () => {
  const prompt = roadmapPrompt('Repair launchNode', 'Inspect sync').replace(
    'Les titres et notes',
    'Instructions complémentaires de l’utilisateur :\nPrime Fleet pipeline: task started on Desktop.\nPrevious tasks done: attachmentNoise.\nCode: git pull\nRoadmap: use roadmap_check planId noise\nPipeline instructions: inspect src/transfer.ts transferConversation\n\nLes titres et notes',
  );
  const query = dossierQuery(prompt);
  assert.match(query, /launchNode/);
  assert.match(query, /src\/transfer\.ts/);
  assert.match(query, /transferConversation/);
  assert.doesNotMatch(query, /Desktop|roadmap_check|attachmentNoise|git|planId/);
});

test('dossier caps repeated file excerpts at two', async () => {
  const index = { search: async (_p, params) => ({ results: params.path ? [] : Array.from({ length: 6 }, (_, i) => ({ path: 'src/a.ts', startLine: i + 1, endLine: i + 1, text: 'duplicate' })) }), map: async () => ({ results: [] }) };
  const result = await buildDossier({ sessionId: 'a' }, { q: 'duplicate' }, index, {});
  assert.equal((result.text.match(/Relevant:/g) || []).length, 2);
});


test('dossier includes relevant nested package commands and index freshness', async () => {
  const index = { search: async (_p, params) => ({ state: 'ready', indexedAt: '2026-10-19T12:00:00Z', results: params.path === 'packages/app/package.json'
    ? [{ path: params.path, startLine: 1, endLine: 3, text: '"typecheck": "npx tsc --noEmit"' }]
    : params.path ? [] : [{ path: 'packages/app/src/app.ts', startLine: 1, endLine: 2, text: 'appCode', stale: true }] }), map: async () => ({ results: [] }) };
  const result = await buildDossier({ sessionId: 'a' }, { q: 'appCode' }, index, {});
  assert.match(result.text, /packages\/app\/package\.json/);
  assert.match(result.text, /npx tsc --noEmit/);
  assert.match(result.text, /2026-10-19T12:00:00Z/);
  assert.match(result.text, /stale/i);
});


test('real index dossier retains late typecheck and lint commands from a long manifest', { timeout: 20000 }, async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { createCodeIndex } = await import('../lib/code-index.mjs');
  const temporary = await mkdtemp(join(tmpdir(), 'studio-dossier-manifest-'));
  const projectPath = join(temporary, 'project'), dataDir = join(temporary, 'data');
  await mkdir(projectPath); await mkdir(dataDir);
  execFileSync('git', ['init', projectPath], { timeout: 5000, stdio: 'ignore', windowsHide: true });
  const scripts = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`test:case-${i}`, `node --test test/${'long-regression-name-'.repeat(4)}${i}.test.mjs`]));
  scripts.typecheck = 'npx tsc --noEmit';
  scripts.lint = 'npx eslint src --max-warnings 0';
  const manifest = JSON.stringify({ scripts }, null, 2);
  assert.ok(manifest.indexOf('typecheck') > 1500);
  assert.ok(manifest.slice(0, manifest.indexOf('typecheck')).split('\n').length < 40);
  await writeFile(join(projectPath, 'package.json'), manifest);
  await writeFile(join(projectPath, 'main.ts'), 'export function manifestFixture() {}');
  const index = createCodeIndex({ dataDir });
  const project = { metricsId: 'b'.repeat(64), path: projectPath };
  try {
    assert.equal((await index.refresh(project)).state, 'ready');
    const dossier = await buildDossier({ sessionId: 'manifest' }, { q: 'manifestFixture' }, index, project);
    assert.match(dossier.text, /npx tsc --noEmit/);
    assert.match(dossier.text, /npx eslint src --max-warnings 0/);
    assert.ok(dossier.text.length <= 4500);
  } finally { await index.close(); await rm(temporary, { recursive: true, force: true }); }
});


test('dossier gives focused identifiers and task titles priority over matching note prose', async () => {
  const index = { search: async (_p, params) => ({ state: 'ready', results: params.path ? [] : [{ path: params.q === 'buildDossier' ? 'src/dossier.mjs' : params.q === 'conversation sync' ? 'src/conversation-sync.mjs' : 'docs/noisy-notes.md', startLine: 1, endLine: 2, text: 'source' }] }), map: async () => ({ results: [] }) };
  const identifier = await buildDossier({ sessionId: 'a' }, { q: roadmapPrompt('Improve buildDossier relevance', 'Select task-specific source context for Roadmap requests.') }, index, {});
  assert.match(identifier.text, /Relevant: src\/dossier\.mjs/);
  const natural = await buildDossier({ sessionId: 'b' }, { q: roadmapPrompt('Corriger conversation sync', 'Synchroniser les conversations entre machines.').replace('Fleet reliability', 'Corriger conversation sync') }, index, {});
  assert.match(natural.text, /Relevant: src\/conversation-sync\.mjs/);
});


test('all native code tool descriptions require re-reading stale files', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../runtime/studio-code-extension.mjs', import.meta.url), 'utf8');
  for (const name of ['studio_code_search', 'studio_code_symbols', 'studio_code_map']) {
    const declaration = source.split('\n').find((line) => line.includes(`['${name}',`));
    assert.match(declaration, /stale: true.*re-read/i, name);
  }
});
