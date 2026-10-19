import test from 'node:test';
import assert from 'node:assert/strict';
import studioContext, { shortenNameLists, trimOldToolResults, preserveCompactionContext } from '../runtime/studio-context-extension.mjs';

test('kernel name hygiene is deterministic and short names remain', () => {
  const text = `These names are still defined: ${Array.from({length: 50}, (_, i) => `x${i}`).join(', ')}.`;
  assert.match(shortenNameLists(text), /50 names/);
  assert.equal(shortenNameLists('These names are still defined: a, b.'), 'These names are still defined: a, b.');
});
test('stable trim tiers preserve recent turns, pairing, metadata and source', () => {
  const messages = [];
  for (let i = 0; i < 24; i++) messages.push(
    { role: 'user', content: `turn ${i}` },
    { role: 'assistant', content: [{type:'toolCall', id:`t${i}`, name:'read', arguments:{path:'a.js'}}] },
    { role: 'toolResult', toolCallId:`t${i}`, content:[{type:'text',text:'x'.repeat(24000)}], isError:false },
  );
  const result = trimOldToolResults(messages);
  assert.equal(result.length, messages.length);
  assert.equal(result[2].content.reduce((n,p)=>n+p.text.length,0), 2048);
  assert.equal(result[26].content.reduce((n,p)=>n+p.text.length,0), 8192);
  assert.equal(result[68], messages[68]);
  assert.equal(result[71], messages[71]);
  assert.equal(result[2].toolCallId, messages[2].toolCallId);
  assert.equal(messages[2].content[0].text.length, 24000);
  assert.deepEqual(trimOldToolResults(result), result);
});
test('native compaction retains preparation and adds bounded evidence', () => {
  const source = [{ role:'assistant', content:[{type:'toolCall',arguments:{path:'runtime/studio-context-extension.mjs'}}, {type:'text',text:'Decision: keep API.\nOpen task: add test.'}] }];
  const event = {preparation:{messagesToSummarize:source,firstKeptEntryId:'cut',fileOps:{read:new Set()} }};
  preserveCompactionContext(event, {cwd:process.cwd()});
  assert.equal(source.length, 1);
  assert.equal(event.preparation.firstKeptEntryId, 'cut');
  assert.match(event.preparation.messagesToSummarize.at(-1).content, /runtime\/studio-context-extension.mjs/);
  assert.match(event.preparation.messagesToSummarize.at(-1).content, /Open task/);
  const handlers={}; studioContext({on:(name, handler)=>handlers[name]=handler});
  assert.equal(typeof handlers.session_before_compact,'function');
});

test('trim boundaries stay fixed between eight-turn milestones', () => {
  const messages = Array.from({length:24}, (_, i) => [{role:'user', content:String(i)}, {role:'toolResult',toolCallId:String(i),content:[{type:'text',text:'x'.repeat(24000)}]}]).flat();
  const prefix = trimOldToolResults(messages);
  for (let i=0; i<7; i++) {
    messages.push({role:'user',content:'more'});
    assert.deepEqual(trimOldToolResults(messages).slice(0,prefix.length),prefix);
  }
});

test('new context hygiene obeys launch and live project/session switches; legacy cleanup stays on', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'studio-context-gate-'));
  const projectPath=join(root,'project'),dataDir=join(root,'studio-data');
  mkdirSync(projectPath);mkdirSync(join(dataDir,'code-index','project'),{recursive:true});
  const settings=join(dataDir,'code-index','project','settings.json');
  const previous=process.env.PRIME_STUDIO_CODE_CONFIG;
  const ctx={cwd:projectPath,sessionManager:{getSessionId:()=> 'session'}};
  const messages=Array.from({length:24},(_,i)=>[{role:'user',content:String(i)},{role:'toolResult',toolCallId:String(i),content:[{type:'text',text:'x'.repeat(24000)}]}]).flat();
  messages.push({role:'custom',customType:'ipython_state',content:`These names are still defined: ${Array.from({length:50},(_,i)=>`x${i}`).join(', ')}.`});
  const handlers={};studioContext({on:(name,fn)=>handlers[name]=fn});
  const check=(enabled,context=ctx)=>{
    const result=handlers.context({messages},context);
    assert.match(result.messages.at(-1).content,/50 names/);
    assert.equal(result.messages[1]===messages[1],!enabled);
    const event={preparation:{messagesToSummarize:[],firstKeptEntryId:'cut'}};
    handlers.session_before_compact(event,context);
    assert.equal(event.preparation.messagesToSummarize.length,enabled?1:0);
  };
  try{
    delete process.env.PRIME_STUDIO_CODE_CONFIG;check(false);
    const config={enabled:true,sessionEnabled:true,dataDir,projectId:'project',projectPath,sessionId:'session'};
    process.env.PRIME_STUDIO_CODE_CONFIG=JSON.stringify({...config,enabled:false});check(false);
    process.env.PRIME_STUDIO_CODE_CONFIG=JSON.stringify({...config,sessionEnabled:false});check(false);
    process.env.PRIME_STUDIO_CODE_CONFIG=JSON.stringify({...config,sessionEnabled:undefined});check(false);
    process.env.PRIME_STUDIO_CODE_CONFIG=JSON.stringify(config);check(true);
    check(false,{...ctx,cwd:root});
    writeFileSync(settings,JSON.stringify({enabled:false}));check(false);
    writeFileSync(settings,JSON.stringify({enabled:true,sessions:{session:false}}));check(false);
    writeFileSync(settings,JSON.stringify({enabled:true,sessions:{session:true}}));check(true);
  }finally{
    if(previous===undefined) delete process.env.PRIME_STUDIO_CODE_CONFIG;else process.env.PRIME_STUDIO_CODE_CONFIG=previous;
    rmSync(root,{recursive:true,force:true});
  }
});


test('single-user autonomous runs age results by assistant turns and retain head and tail', () => {
  const messages = [{role:'user',content:'Do the task'}];
  for (let i=0;i<24;i++) messages.push(
    {role:'assistant',content:[{type:'toolCall',id:`a${i}`,name:'ipython',arguments:{code:'print(log)'}}]},
    {role:'toolResult',toolCallId:`a${i}`,content:[{type:'text',text:'HEAD\n'+'x'.repeat(24000)+'\nTAIL'}]},
  );
  const result=trimOldToolResults(messages);
  const text=result[2].content.map(p=>p.text||'').join('');
  assert.ok(text.length<3000);
  assert.match(text,/HEAD/);assert.match(text,/TAIL/);assert.match(text,/omitted/);
  assert.equal(result.at(-1),messages.at(-1));
  assert.deepEqual(trimOldToolResults(messages.concat({role:'assistant',content:'Next'})).slice(0,messages.length),result);
});

test('huge fresh results are capped on first send with stable pairing and all text blocks bounded', () => {
  const image={type:'image',data:'unchanged'};
  const messages=[{role:'user',content:'Run'}, {role:'assistant',content:[{type:'toolCall',id:'huge',name:'bash'}]},
    {role:'toolResult',toolCallId:'huge',isError:true,content:[{type:'text',text:'HEAD'+'x'.repeat(40000)},image,{type:'text',text:'y'.repeat(40000)+'TAIL'}]}];
  const snapshot=structuredClone(messages);
  const result=trimOldToolResults(messages);
  const text=result[2].content.filter(p=>p.type==='text').map(p=>p.text).join('');
  assert.ok(text.length<34000);assert.match(text,/HEAD/);assert.match(text,/TAIL/);assert.match(text,/omitted/);
  assert.equal(result[1],messages[1]);assert.equal(result[2].content[1],image);assert.equal(result[2].isError,true);
  assert.deepEqual(messages,snapshot);assert.deepEqual(trimOldToolResults(result),result);
  assert.deepEqual(trimOldToolResults(messages.concat({role:'assistant',content:'Continue'})).slice(0,3),result);
});

test('compaction extracts project-scoped paths from arbitrary tool arguments and French decisions', async () => {
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'studio-compaction-'));
  const project=join(root,'project');mkdirSync(project);mkdirSync(join(project,'src'));
  for(const name of ['alpha.js','beta.js','gamma.js']) writeFileSync(join(project,'src',name),'');
  writeFileSync(join(root,'outside.js'),'');
  symlinkSync(root,join(project,'escape'),'junction');
  const messages=[{role:'assistant',content:[
    {type:'toolCall',name:'ipython',arguments:{code:"p = Path('src/alpha.js').read_text()"}},
    {type:'toolCall',name:'bash',arguments:{command:'node src/beta.js'}},
    {type:'toolCall',name:'edit',arguments:{nested:{target:'src/gamma.js'},path:'../outside.js',other:'escape/outside.js'}},
    {type:'text',text:'Décision : garder cette API.\nÀ faire : ajouter le test.\nBloqué : accès absent.'},
  ]}];
  const event={preparation:{messagesToSummarize:messages,fileOps:{read:new Set()},firstKeptEntryId:'keep'}};
  try {
    preserveCompactionContext(event,{cwd:project});
    const text=event.preparation.messagesToSummarize.at(-1).content;
    for(const name of ['alpha.js','beta.js','gamma.js']) assert.ok(text.includes(name),name);
    assert.doesNotMatch(text,/outside.js/);assert.match(text,/Décision/);assert.match(text,/À faire/);assert.match(text,/Bloqué/);
    assert.equal(messages.length,1);assert.equal(event.preparation.firstKeptEntryId,'keep');
  } finally {rmSync(root,{recursive:true,force:true});}
});


test('compaction path discovery bounds argument traversal, scanned text and candidates', () => {
  const prepare = argumentsValue => {
    const event={preparation:{messagesToSummarize:[{role:'assistant',content:[{type:'toolCall',arguments:argumentsValue}]}]}};
    preserveCompactionContext(event,{cwd:process.cwd()});
    return event.preparation.messagesToSummarize.at(-1).content;
  };
  let visited=0;
  const broad={};
  for(let i=0;i<3000;i++) Object.defineProperty(broad,`arg${i}`,{enumerable:true,get(){visited++;return 'no-path';}});
  prepare(broad);
  assert.ok(visited<=2048,`visited ${visited} argument values`);
  const path='runtime/studio-context-extension.mjs';
  assert.match(prepare({code:`'${path}'\n`+'x'.repeat(300000)}),/runtime\/studio-context-extension.mjs/);
  assert.doesNotMatch(prepare({code:'x'.repeat(300000)+`\n'${path}'`}),/Verified project paths[^\n]*runtime\//);
  assert.doesNotMatch(prepare({code:'missing.js '.repeat(3000)+`'${path}'`}),/Verified project paths[^\n]*runtime\//);
});
