import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

process.env.LANGFUSE_SECRET_KEY='';process.env.LANGFUSE_PUBLIC_KEY='';
const {createEvaluationApp}=await import('../server/evaluation/app.js');
const {validateLocationCases,scoreLocation}=await import('../server/evaluation/location.js');
const {UnresolvedAddressError}=await import('../server/providers/geocode-address.js');

test('location dataset validation and scores include failed positives and distinguish API errors from correct rejection',()=>{
  assert.throws(()=>validateLocationCases([{id:'x',address:'Street'}]));
  assert.throws(()=>validateLocationCases([{id:'x',address:'Street',expectedLocation:{latitude:91,longitude:0}}]));
  const cases=validateLocationCases([
    ...['near','far','missing'].map(id=>({id,address:id,expectedLocation:{latitude:12,longitude:77}})),
    ...['invalid','accepted','error'].map(id=>({id,address:id,expectedResolvable:false})),
  ]);
  assert.throws(()=>validateLocationCases([cases[0],cases[0]]));
  const results=cases.map(entry=>({id:entry.id,status:entry.id==='error'?'error' as const:['invalid','missing'].includes(entry.id)?'unresolved' as const:'located' as const,
    actual:null,distanceMetres:entry.id==='near'?100:entry.id==='far'?900:null,durationMs:100,error:null}));
  const score=scoreLocation(cases,results);
  assert.deepEqual(score.withinTarget,{numerator:1,denominator:3,percent:33.33});
  assert.equal(score.falseAcceptance.numerator,1);assert.equal(score.falseAcceptance.denominator,3);
  assert.equal(score.correctRejection.numerator,1);assert.equal(score.errors,1);
  assert.equal(score.medianDistanceMetres,500);assert.equal(score.meanResponseMs,100);
  assert.equal(scoreLocation([],[]).withinTarget.percent,null);
});

test('location evaluation HTTP flow validates without Google, requires consent, runs sequentially and persists downloadable results',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'helpfully-location-eval-'));
  let calls=0;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const service=await createEvaluationApp({directory,locate:async address=>{
    calls++;if(calls===1)await gate;
    if(address==='Invalid address')throw new UnresolvedAddressError();
    return {latitude:12,longitude:77};
  }});
  const server=service.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const url='http://127.0.0.1:'+address.port;
  try{
    const config=await(await fetch(url+'/api/config')).json();
    const post=(route:string,body:object,origin?:string)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Evaluation-Token':config.token,...(origin?{origin}:{})},body:JSON.stringify(body)});
    const cases=[{id:'near',address:'Known street',expectedLocation:{latitude:12,longitude:77}},
      {id:'invalid',address:'Invalid address',expectedResolvable:false}];
    assert.equal((await post('/api/location/validate',{cases},'https://example.com')).status,403);
    assert.equal((await post('/api/location/validate',{cases})).status,200);assert.equal(calls,0);
    assert.equal((await post('/api/location/runs',{cases})).status,400);assert.equal(calls,0);
    const started=await post('/api/location/runs',{cases,confirmApiUsage:true});assert.equal(started.status,202);
    const run=await started.json();
    assert.equal((await post('/api/location/runs',{cases,confirmApiUsage:true})).status,409);
    release();let result=run;
    for(let i=0;i<100;i++){result=await(await fetch(url+'/api/location/runs/'+run.id)).json();if(result.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(result.status,'completed');assert.equal(calls,2);assert.equal(result.results.length,2);
    assert.equal(result.scores.withinTarget.percent,100);assert.equal(result.scores.correctRejection.percent,100);
    const download=await fetch(url+'/api/location/runs/'+run.id+'?download=true');assert.match(download.headers.get('content-disposition')!,/attachment/);
    assert.equal((await download.json()).id,run.id);
    assert.equal((await(await fetch(url+'/api/location/runs')).json()).length,1);
    assert.equal((await(await fetch(url+'/api/location/dataset')).json()).length,15);
    assert.equal((await fetch(url+'/location.html')).status,200);
  }finally{
    release();await service.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('helpfully-location-eval-'));
    await rm(target,{recursive:true,force:true});
  }
});
