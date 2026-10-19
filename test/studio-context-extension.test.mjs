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
  assert.equal(result[2].content[0].text.length, 2048);
  assert.equal(result[26].content[0].text.length, 8192);
  assert.equal(result[68], messages[68]);
  assert.equal(result[71], messages[71]);
  assert.equal(result[2].toolCallId, messages[2].toolCallId);
  assert.equal(messages[2].content[0].text.length, 24000);
  assert.deepEqual(trimOldToolResults(result), result);
});
test('native compaction retains preparation and adds bounded evidence', () => {
  const source = [{ role:'assistant', content:[{type:'toolCall',arguments:{path:'src/a.js'}}, {type:'text',text:'Decision: keep API.\nOpen task: add test.'}] }];
  const event = {preparation:{messagesToSummarize:source,firstKeptEntryId:'cut',fileOps:{read:new Set()} }};
  preserveCompactionContext(event);
  assert.equal(source.length, 1);
  assert.equal(event.preparation.firstKeptEntryId, 'cut');
  assert.match(event.preparation.messagesToSummarize.at(-1).content, /src\/a.js/);
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
