// Real native loader + deterministic loopback provider. No external providers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAgentRuntime } from '../lib/agent.mjs';
import { createCodeIndex } from '../lib/code-index.mjs';
import { dossierPath } from './studio-code-worker.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-studio-code-native-'));
const dataDir = join(root, 'studio-data'), cwd = join(root, 'fixture-project');
const agentHome = join(dataDir, 'agent'), sessionDir = join(agentHome, 'sessions');
await Promise.all([cwd, sessionDir].map((path) => mkdir(path, { recursive:true })));
execFileSync('git', ['init', cwd], {timeout:10000,windowsHide:true,stdio:'ignore'});
await writeFile(join(cwd, 'math.mjs'), 'export function dossierFixture(value) { return value + 1; }\n');
await writeFile(join(cwd, 'AGENTS.md'), 'Fixture source. Use node --test for validation.\n');
await writeFile(join(cwd, 'package.json'), JSON.stringify({scripts:{test:'node --test',build:'node --check math.mjs'}}));
const project = {id:'native-fixture',path:cwd}, codeContext = {dataDir, projectId:project.id, projectPath:cwd, enabled:true, sessionEnabled:true, pins:[{path:'math.mjs',startLine:1}]};
const index = createCodeIndex({dataDir});
assert.equal((await index.refresh(project)).state, 'ready');
await index.close();
const requests=[], events=[], errors=[];
const tools=[['studio_code_search',{q:'dossierFixture'}],['studio_code_symbols',{symbol:'dossierFixture'}],['studio_code_map',{path:'math.mjs'}]];
const provider=createServer(async(req,res)=>{
  try {
    let raw=''; for await(const chunk of req) raw+=chunk;
    const body=JSON.parse(raw); requests.push(body);
    for(const [name] of tools) assert.ok(body.tools.some(t=>t.function.name===name),name);
    const transcript=JSON.stringify(body.messages);
    assert.equal((transcript.match(/Project code dossier \(local index/g)||[]).length,1,'exactly one dossier');
    assert.ok(body.messages.filter(m=>m.role==='system').every(m=>!JSON.stringify(m).includes('Project code dossier')));
    if(requests.length>1) {
      assert.deepEqual(body.messages.filter(m=>m.role==='system'),requests[0].messages.filter(m=>m.role==='system'),'stable system prefix');
      assert.deepEqual(body.tools,requests[0].tools,'stable tool definitions');
      if(requests.length<=4) assert.deepEqual(body.messages.slice(0,requests[0].messages.length),requests[0].messages,'stable full request prefix');
      const result=body.messages.findLast(m=>m.role==='tool');
      if(requests.length<=4) assert.match(result.content,/math\.mjs/);
    }
    const next=tools[requests.length-1];
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const frame=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    frame({role:'assistant'});
    if(next){frame({tool_calls:[{index:0,id:`call-${requests.length}`,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]});frame({},'tool_calls');}
    else {frame({content:'Local code fixture verified.'});frame({},'stop');}
    res.end('data: [DONE]\n\n');
  } catch(error){errors.push(error.message);res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await writeFile(join(agentHome,'auth.json'),'{}');
await writeFile(join(agentHome,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'local',autoRefine:{enabled:false},compaction:{enabled:false},retry:{enabled:false},telemetry:{enabled:false,noticeShown:true}}));
await writeFile(join(agentHome,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'fixture-only',models:[{id:'local',name:'local',input:['text'],contextWindow:131072,maxTokens:1024}]}}}));
let runtime;
const timeout=setTimeout(()=>{console.error('Native fixture hard timeout');process.exit(1);},120000);
try{
  runtime=createAgentRuntime({agentHome,sessionDir,env:{...process.env,PRIME_AGENT_TELEMETRY:'0'}});
  const first=await runtime.start({cwd,message:'Find dossierFixture and inspect its source map.',model:'fixture/local',codeContext,onEvent:e=>events.push(e)});
  assert.equal((await first.done).status,'completed',JSON.stringify(events.slice(-5)));
  assert.ok(first.sessionId);
  const dossier=JSON.parse(await readFile(dossierPath({...codeContext,sessionId:first.sessionId}),'utf8'));
  assert.ok(dossier.text.length<=4500);
  const second=await runtime.start({cwd,sessionId:first.sessionId,message:'Continue with the same source context.',model:'fixture/local',codeContext,onEvent:e=>events.push(e)});
  assert.equal((await second.done).status,'completed');
  assert.deepEqual(errors,[]);
  assert.equal(requests.length,5);
  assert.equal(JSON.parse(await readFile(dossierPath({...codeContext,sessionId:first.sessionId}),'utf8')).createdAt,dossier.createdAt);
  console.log(JSON.stringify({passed:true,root,requests:requests.length,checks:['native tool discovery and source results','single dossier across resume','unchanged system prefix','bounded persisted dossier']}));
}catch(error){await writeFile(join(dataDir,'diagnostic.json'),JSON.stringify({requests,events,errors},null,2));console.error(error);process.exitCode=1;}
finally{clearTimeout(timeout);await runtime?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
