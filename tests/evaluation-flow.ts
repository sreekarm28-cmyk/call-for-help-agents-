import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateDataset, parseFile, loadSavedDataset, DatasetError, type EvaluationCase, type Answers } from '../server/evaluation/dataset.js';
import { scoreRun, type CaseResult } from '../server/evaluation/scoring.js';
import { RunStore } from '../server/evaluation/store.js';

// Keep these tests offline, including optional tracing. No DB or telephone modules are imported.
process.env.LANGFUSE_SECRET_KEY = '';
process.env.LANGFUSE_PUBLIC_KEY = '';
process.env.GOOGLE_API_KEY = 'test-placeholder-not-a-real-key';
const { createEvaluationApp } = await import('../server/evaluation/app.js');
const { evaluateCase, evaluationPrompt } = await import('../server/evaluation/model.js');

const input = {id:'case-1',transcript:'Agent: When and how much?\nYou: Tomorrow evening. Five hundred to visit.',calledAt:'2026-11-26T10:00:00+05:30',timezone:'Asia/Kolkata'};
const expected = {visit_fee:500,visit_date:'2026-11-27',visit_time:null,enough_info:'yes' as const};
const label = {id:'case-1',expected};
const entry = () => validateDataset([input],[label])[0];
const completed = (id:string,actual:Answers=expected): CaseResult => ({id,status:'completed',actual,durationMs:20,usage:{input:12,output:4,total:16},error:null});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(),'helpfully-eval-test-'));
  return {directory, async cleanup(){
    const target=path.resolve(directory),parent=path.resolve(tmpdir());
    if(path.dirname(target)!==parent||!path.basename(target).startsWith('helpfully-eval-test-'))throw Error('Unsafe temporary-test cleanup target');
    await rm(target,{recursive:true,force:true});
  }};
}

test('dataset validation rejects mismatched IDs, duplicate IDs, invalid dates, and missing answers',()=>{
  assert.equal(validateDataset([input],[label])[0].expected.visit_time,null);
  assert.equal(parseFile('\uFEFF'+JSON.stringify([input]),'input').length,1);
  assert.equal(parseFile(JSON.stringify(input)+'\n','input').length,1);
  assert.equal(parseFile(JSON.stringify({cases:[label]}),'labels').length,1);
  assert.throws(()=>validateDataset([input],[{...label,id:'wrong'}]),DatasetError);
  assert.throws(()=>validateDataset([input,input],[label]),/Duplicate/);
  assert.throws(()=>validateDataset([input],[label,label]),/Duplicate/);
  assert.throws(()=>validateDataset([input],[{...label,expected:{visit_fee:500}}]),/Invalid answers/);
  assert.throws(()=>validateDataset([{...input,calledAt:'2026-02-31T10:00:00+05:30'}],[label]),/Invalid conversation/);
  assert.throws(()=>validateDataset([input],[{...label,transcriptSha256:'wrong'}]),/differs/);
  assert.throws(()=>validateDataset([input],[{...label,expected:{...expected,visit_date:'2026-02-31'}}]),/Invalid answers/);
});

test('transcript identity tolerates Windows line endings but rejects changed conversation text',()=>{
  const transcriptSha256=createHash('sha256').update(input.transcript).digest('hex');
  const reference={...label,transcriptSha256};
  assert.equal(validateDataset([{...input,transcript:input.transcript.replace(/\n/g,'\r\n')}],[reference]).length,1);
  assert.throws(()=>validateDataset([{...input,transcript:input.transcript+' changed'}],[reference]),/Transcript differs/);
});

test('all saved synthetic labels load; only disputed fields relevant to this evaluator are excluded',async()=>{
  const cases=await loadSavedDataset('synthetic');assert.equal(cases.length,38);
  assert.deepEqual(cases.find(c=>c.id==='synthetic-04')!.excludedFields,['visit_fee']);
  assert.deepEqual(cases.find(c=>c.id==='synthetic-07')!.excludedFields,[]);
  assert.deepEqual(cases.find(c=>c.id==='synthetic-46')!.excludedFields,['visit_date','enough_info']);
  const window=cases.find(c=>c.id==='synthetic-45')!;
  assert.equal(window.expected.visit_time,null);assert.equal(window.expected.enough_info,'yes');
  const combined=cases.find(c=>c.id==='synthetic-44')!;
  assert.equal(combined.expected.visit_fee,null);assert.equal(combined.expected.enough_info,'yes');
  assert.equal(cases.some(c=>c.id==='synthetic-21'),false);
});

test('scores handle invented times, false Yes, null matches, zero fees, exclusions and model failures',()=>{
  const a=entry();const b={...entry(),id:'case-2',expected:{...expected,enough_info:'no' as const}};
  const wrongTime={...expected,visit_time:'17:00'};
  const scores=scoreRun([a,b],[completed(a.id,wrongTime),completed(b.id,expected)]);
  assert.deepEqual(scores.overall,{numerator:6,denominator:8,percent:75});
  assert.deepEqual(scores.completeCase,{numerator:0,denominator:2,percent:0});
  assert.deepEqual(scores.inventedValues,{numerator:1,denominator:2,percent:50});
  assert.deepEqual(scores.falseYes,{numerator:1,denominator:1,percent:100});
  assert.equal(scores.enoughInfo.percent,50);
  const free={...entry(),expected:{...expected,visit_fee:0}};
  assert.equal(scoreRun([free],[completed(free.id,{...expected,visit_fee:0})]).overall.percent,100);
  const disputed={...entry(),excludedFields:['visit_time'] as EvaluationCase['excludedFields']};
  const excluded=scoreRun([disputed],[completed(disputed.id,wrongTime)]);
  assert.equal(excluded.overall.percent,100);assert.equal(excluded.overall.denominator,3);
  assert.equal(excluded.completeCase.percent,null);assert.equal(excluded.perField.visit_time.excluded,1);
  const failure:CaseResult={id:a.id,status:'error',actual:null,durationMs:5,usage:{},error:'offline'};
  const failed=scoreRun([a],[failure]);assert.equal(failed.overall.denominator,4);assert.equal(failed.overall.percent,0);
  assert.equal(failed.modelErrors,1);assert.equal(failed.inventedValues.percent,null);
  assert.equal(scoreRun([a],[]).overall.percent,null);
});

test('Gemini evaluation sends no answer key or summary instructions and returns reported usage (mocked network)',async()=>{
  const originalFetch=globalThis.fetch;
  let requests=0;
  globalThis.fetch=async(url,init)=>{
    requests++;assert.match(String(url),/^https:\/\/generativelanguage.googleapis.com\//);
    const body=JSON.parse(init!.body as string);
    assert.ok(body.contents[0].parts[0].text.endsWith(input.transcript));assert.match(body.contents[0].parts[0].text,/Reference call date: 2026-11-26/);
    assert.ok(JSON.stringify(body).includes('2026-11-26'));
    assert.ok(!JSON.stringify(body).includes('reference-secret-marker'));
    assert.deepEqual(Object.keys(body.generationConfig.responseJsonSchema.properties).sort(),['availability_as_said','enough_info','visit_date','visit_fee','visit_time']);
    assert.ok(!evaluationPrompt.includes('- summary:'));
    assert.match(evaluationPrompt,/discount request, an interrupted reply/);
    assert.match(evaluationPrompt,/Never map "afternoon"/);
    assert.match(evaluationPrompt,/AT LEAST TWO/);
    assert.match(evaluationPrompt,/day \+ time\/period, day \+ fee, OR time\/period \+ fee/);
    assert.match(evaluationPrompt,/ONLY for fields still missing\/unknown/);
    assert.match(evaluationPrompt,/All three are NOT required/);
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({...expected,visit_date:null,availability_as_said:'Tomorrow evening.'})}]}}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:10,thoughtsTokenCount:3,totalTokenCount:53}}),{status:200});
  };
  try{const result=await evaluateCase({...entry(),reviewNote:'reference-secret-marker'});assert.deepEqual(result.actual,{...expected,visit_date:null});assert.equal(result.availabilityAsSaid,'Tomorrow evening.');assert.deepEqual(result.usage,{input:40,output:13,total:53});assert.equal(requests,1);}
  finally{globalThis.fetch=originalFetch;}
});

test('product extraction sends transcript with the reference call date',async()=>{
  const {extractTranscript}=await import('../server/transcript-extraction.js');const originalFetch=globalThis.fetch;
  const response={provider_response:'offer_received',visit_fee:500,fee_covers:'Inspection',repair_fee_min:null,repair_fee_max:null,repair_cost_notes:null,visit_date:null,visit_time:null,availability_as_said:'Tomorrow evening.',summary:'Provider offers tomorrow evening; inspection costs 500.',evidence:['Tomorrow evening. Five hundred to visit.']};
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.ok(body.contents[0].parts[0].text.endsWith(input.transcript));assert.match(body.contents[0].parts[0].text,/Reference call date: 2026-11-26/);assert.ok(!body.systemInstruction.parts[0].text.includes('Resolve the confirmed day against the supplied call date'));return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(response)}]}}]}),{status:200});};
  try{const result=await extractTranscript(input.transcript,input.calledAt);assert.equal(result.visit_date,null);assert.equal(result.availability_as_said,'Tomorrow evening.');}finally{globalThis.fetch=originalFetch;}
});

test('local HTTP flow validates, prevents cross-origin runs, runs once, persists results and downloads them',async()=>{
  const temp=await temporaryDirectory();let modelCalls=0;
  const service=await createEvaluationApp({directory:temp.directory,evaluator:async()=>{modelCalls++;return {actual:{...expected,visit_time:'17:00'},usage:{input:30,output:10,total:40}};}});
  const server=service.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  try{
    const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/Transcript evaluation/);
    assert.match(home.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
    const config=await(await fetch(base+'/api/config')).json();
    const post=(url:string,body:object,extra:Record<string,string>={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Evaluation-Token':config.token,...extra},body:JSON.stringify(body)});
    const body={mode:'manual',input,label};
    assert.equal((await post('/api/runs',{...body,confirmApiUsage:true},{Origin:'https://other.example'})).status,403);
    assert.equal((await post('/api/runs',{...body,confirmApiUsage:true},{'X-Evaluation-Token':'wrong'})).status,403);
    assert.equal((await post('/api/runs',body)).status,400);assert.equal(modelCalls,0);
    const validated=await post('/api/validate',body);assert.equal(validated.status,200);assert.equal((await validated.json()).total,1);assert.equal(modelCalls,0);
    assert.equal((await post('/api/validate',{mode:'upload',inputsText:JSON.stringify([input]),labelsText:JSON.stringify([{...label,id:'not-matching'}])})).status,400);assert.equal(modelCalls,0);
    const response=await post('/api/runs',{...body,confirmApiUsage:true});assert.equal(response.status,202);const first=await response.json();
    let result=first;for(let i=0;i<100&&result.status==='running';i++){await new Promise(r=>setTimeout(r,10));result=await(await fetch(base+'/api/runs/'+first.id)).json();}
    assert.equal(result.status,'completed');assert.equal(result.scores.overall.percent,75);assert.equal(result.scores.inventedValues.percent,100);assert.equal(modelCalls,1);
    assert.equal(result.results[0].usage.total,40);assert.ok(!Object.hasOwn(result.results[0].actual,'summary'));
    const saved=JSON.parse(await readFile(path.join(temp.directory,first.id+'.json'),'utf8'));assert.equal(saved.cases[0].transcript,input.transcript);
    const download=await fetch(base+'/api/runs/'+first.id+'?download=true');assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')!,/attachment/);
    assert.equal((await(await fetch(base+'/api/runs')).json()).length,1);
    assert.equal((await fetch(base+'/api/runs/not-a-run')).status,404);
  }finally{await service.stop();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await temp.cleanup();}
});

test('a run rejects concurrent starts and restart marks interrupted work without repeating model calls',async()=>{
  const temp=await temporaryDirectory();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const service=await createEvaluationApp({directory:temp.directory,evaluator:async()=>{await gate;return {actual:expected,usage:{}};}});
  const server=service.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base='http://127.0.0.1:'+addr.port;
  try{const config=await(await fetch(base+'/api/config')).json();const post=()=>fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Evaluation-Token':config.token},body:JSON.stringify({mode:'manual',input,label,confirmApiUsage:true})});
    const responses=await Promise.all([post(),post()]);assert.deepEqual(responses.map(r=>r.status).sort(),[202,409]);release();await service.stop();
    const files=await readdir(temp.directory);const run=JSON.parse(await readFile(path.join(temp.directory,files.find(n=>n.endsWith('.json'))!),'utf8'));
    run.id=randomUUID();run.status='running';run.results=[];const store=new RunStore(temp.directory);await store.save(run);await store.initialize();assert.equal((await store.get(run.id))!.status,'interrupted');
  }finally{release();await service.stop();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await temp.cleanup();}
});
