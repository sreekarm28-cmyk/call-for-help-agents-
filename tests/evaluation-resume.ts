import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {RunStore,type EvaluationRun} from '../server/evaluation/store.js';
import {validateDataset} from '../server/evaluation/dataset.js';

process.env.LANGFUSE_SECRET_KEY='';process.env.LANGFUSE_PUBLIC_KEY='';process.env.GOOGLE_API_KEY='test-placeholder-not-a-real-key';
const {executeRun}=await import('../server/evaluation/runner.js');
const {GeminiRateLimitError,TemporaryGeminiError,readGeminiRateLimit}=await import('../server/gemini.js');
const {modelConfiguration,evaluationPrompt,contextForRun}=await import('../server/evaluation/model.js');
const {createEvaluationApp}=await import('../server/evaluation/app.js');
const answer={visit_fee:400,visit_date:'2026-11-27',visit_time:null,enough_info:'yes' as const};
const cases=()=>validateDataset(['a','b','c'].map(id=>({id,transcript:'Agent: When and fee?\nYou: Tomorrow afternoon, 400 to inspect.',calledAt:'2026-11-26T10:00:00+05:30'})),['a','b','c'].map(id=>({id,expected:answer})));
const makeRun=():EvaluationRun=>({id:randomUUID(),createdAt:new Date().toISOString(),finishedAt:null,status:'running',configuration:modelConfiguration,promptSnapshot:evaluationPrompt,datasetSha256:'test',cases:cases(),results:[],attemptHistory:[]});
async function temporary(){const directory=await mkdtemp(path.join(tmpdir(),'helpfully-eval-resume-'));return {directory,async cleanup(){const target=path.resolve(directory);if(path.dirname(target)!==path.resolve(tmpdir())||!path.basename(target).startsWith('helpfully-eval-resume-'))throw Error('Unsafe test cleanup');await rm(target,{recursive:true,force:true});}};}

test('429 metadata respects Retry-After, provider retry details and explicitly daily quota',async()=>{
  const parsed=await readGeminiRateLimit(new Response(JSON.stringify({error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'23.5s'},{violations:[{quotaId:'GenerateRequestsPerDayPerProject'}]}]}}),{status:429,headers:{'retry-after':'12'}}));
  assert.equal(parsed.retryAfterMs,23500);assert.equal(parsed.dailyQuota,true);
  const empty=await readGeminiRateLimit(new Response('not JSON',{status:429}));assert.equal(empty.retryAfterMs,null);assert.equal(empty.dailyQuota,false);
});

test('rate-limited cases retry with backoff, stay unique, retain availability and preserve successful cases',async()=>{
  const temp=await temporary();try{const store=new RunStore(temp.directory);await store.initialize();const run=makeRun();const called:string[]=[],waits:number[]=[];let throttled=false;
    await executeRun(run,{store,context:await contextForRun(run),shouldStop:()=>false,requestIntervalMs:0,wait:async ms=>{waits.push(ms);},evaluator:async c=>{called.push(c.id);if(c.id==='b'&&!throttled){throttled=true;throw new GeminiRateLimitError(12000,false);}return {actual:answer,availabilityAsSaid:'Tomorrow afternoon',usage:{input:10,output:4,total:14}};}});
    assert.equal(run.status,'completed');assert.deepEqual(called,['a','b','b','c']);assert.deepEqual(waits,[12000]);assert.equal(new Set(run.results.map(r=>r.id)).size,3);assert.equal(run.results.length,3);assert.equal(run.attemptHistory!.length,4);assert.equal(run.results[1].availabilityAsSaid,'Tomorrow afternoon');assert.equal(run.results[1].actual!.visit_time,null);
  }finally{await temp.cleanup();}
});

test('persistent rate limiting pauses after bounded retries and a daily limit pauses immediately',async()=>{
 const temp=await temporary();try{const store=new RunStore(temp.directory);await store.initialize();for(const daily of [false,true]){const run=makeRun();let count=0;const waits:number[]=[];await executeRun(run,{store,context:await contextForRun(run),shouldStop:()=>false,requestIntervalMs:0,wait:async ms=>{waits.push(ms);},evaluator:async()=>{count++;throw new GeminiRateLimitError(null,daily);}});assert.equal(run.status,'paused');assert.equal(count,daily?1:3);assert.equal(run.results.length,1);assert.equal(run.attemptHistory!.length,count);assert.equal(waits.length,daily?0:2);assert.match(run.pauseReason!,daily?/daily quota/:/rate-limited/);}}
 finally{await temp.cleanup();}
});

test('Resume uses the same run and original prompt, preserves successes and never calls them again',async()=>{
 const temp=await temporary();const oldPrompt=evaluationPrompt+'\nPrevious compatible wording.';
 const seen:string[]=[];
 const service=await createEvaluationApp({directory:temp.directory,requestIntervalMs:0,retryWait:async()=>{},evaluator:async(c,context)=>{seen.push(c.id);assert.equal(context!.prompt,oldPrompt);assert.equal(context!.captureAvailability,true);return {actual:answer,usage:{input:2,output:2,total:4}};}});
 const run=makeRun();run.status='interrupted';run.configuration={...modelConfiguration,promptVersion:'previous-compatible-prompt',promptSha256:createHash('sha256').update(oldPrompt).digest('hex')};run.promptSnapshot=oldPrompt;
 const successful={id:'a',status:'completed' as const,actual:answer,durationMs:100,usage:{input:10,output:5,total:15},error:null};run.results=[successful,{id:'b',status:'error',actual:null,durationMs:20,usage:{},error:'Gemini returned HTTP 429'}];delete run.attemptHistory;await service.store.save(run);
 const server=service.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert.ok(address&&typeof address!=='string');const url='http://127.0.0.1:'+address.port;
 try{const config=await(await fetch(url+'/api/config')).json();const post=(body:object)=>fetch(url+'/api/runs/'+run.id+'/resume',{method:'POST',headers:{'Content-Type':'application/json','X-Evaluation-Token':config.token},body:JSON.stringify(body)});
  assert.equal((await post({})).status,400);assert.deepEqual(seen,[]);
  const first=await(await fetch(url+'/api/runs/'+run.id)).json();assert.equal(first.canResume,true);assert.equal(first.promptChanged,true);assert.equal(first.remainingCases,2);
  assert.equal((await post({confirmApiUsage:true})).status,202);let result=first;for(let i=0;i<100;i++){result=await(await fetch(url+'/api/runs/'+run.id)).json();if(result.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.status,'completed');assert.deepEqual(seen,['b','c']);assert.equal(result.id,run.id);assert.deepEqual(result.results.find((r:{id:string})=>r.id==='a'),successful);assert.equal(result.results.length,3);assert.equal(result.scores.overall.percent,100);assert.equal(result.scores.usage.total,23);assert.equal(result.attemptHistory.length,4);assert.equal(result.resumedAt.length,1);assert.equal((await post({confirmApiUsage:true})).status,409);
 }finally{await service.stop();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await temp.cleanup();}
});

test('unknown prompt versions and corrupted snapshots cannot silently mix model versions',async()=>{
 const run=makeRun();run.promptSnapshot='wrong prompt';await assert.rejects(()=>contextForRun(run),/unavailable model or prompt/);
});

test('runs with different date context cannot silently resume',async()=>{
 const run=makeRun();run.configuration={...run.configuration};delete run.configuration.referenceDateProvided;await assert.rejects(()=>contextForRun(run),/different reference call-date context/);
});

test('a persistence failure does not overwrite a valid model response with a model error',async()=>{
 const temp=await temporary();try{const store=new RunStore(temp.directory);await store.initialize();const save=store.save.bind(store);store.save=async run=>{if(run.results.some(r=>r.status==='completed'))throw Error('simulated disk failure');await save(run);};const run=makeRun();let calls=0;await assert.rejects(()=>executeRun(run,{store,context:{prompt:evaluationPrompt,captureAvailability:true},requestIntervalMs:0,shouldStop:()=>false,evaluator:async()=>{calls++;return {actual:answer,usage:{}};}}),/disk failure/);assert.equal(calls,1);assert.equal(run.results[0].status,'completed');assert.deepEqual(run.results[0].actual,answer);}
 finally{await temp.cleanup();}
});

test('503 and timeout failures retry automatically, preserve successes, and count each attempt once',async()=>{
 const temp=await temporary();try{const store=new RunStore(temp.directory);await store.initialize();const run=makeRun(),calls:string[]=[],waits:number[]=[];let failedB=false,failedC=false;
  await executeRun(run,{store,context:await contextForRun(run),requestIntervalMs:0,shouldStop:()=>false,wait:async ms=>{waits.push(ms);},evaluator:async c=>{calls.push(c.id);if(c.id==='b'&&!failedB){failedB=true;throw new TemporaryGeminiError('Gemini returned HTTP 503',7000);}if(c.id==='c'&&!failedC){failedC=true;throw new TemporaryGeminiError('Gemini connection failed or timed out.');}return {actual:answer,usage:{},availabilityAsSaid:'Tomorrow afternoon'};}});
  assert.equal(run.status,'completed');assert.deepEqual(calls,['a','b','b','c','c']);assert.deepEqual(waits,[7000,5000]);assert.equal(run.results.length,3);assert.equal(run.attemptHistory!.length,5);assert.ok(run.results.every(r=>r.status==='completed'));
 }finally{await temp.cleanup();}
});

test('persistent 503 pauses after two retries instead of exhausting requests or dropping results',async()=>{
 const temp=await temporary();try{const store=new RunStore(temp.directory);await store.initialize();const run=makeRun();let calls=0;const waits:number[]=[];
  await executeRun(run,{store,context:await contextForRun(run),requestIntervalMs:0,shouldStop:()=>false,wait:async ms=>{waits.push(ms);},evaluator:async()=>{calls++;throw new TemporaryGeminiError('Gemini returned HTTP 503');}});
  assert.equal(run.status,'paused');assert.equal(calls,3);assert.deepEqual(waits,[5000,10000]);assert.equal(run.results.length,1);assert.match(run.pauseReason!,/temporarily unavailable/);
 }finally{await temp.cleanup();}
});
