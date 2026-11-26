import { answerSchema, fields } from './dataset.js';
import { GeminiRateLimitError, TemporaryGeminiError } from '../gemini.js';
import type { EvaluateCase, ModelContext } from './model.js';
import type { CaseResult } from './scoring.js';
import type { EvaluationRun, RunStore } from './store.js';

export type RunnerOptions = {
  store: RunStore; evaluator: EvaluateCase; context: ModelContext; shouldStop:()=>boolean;
  requestIntervalMs?: number; maxRateRetries?: number; maxTemporaryRetries?: number; wait?:(ms:number)=>Promise<void>;
};
export function remainingCases(run: EvaluationRun) {
  const done=new Set(run.results.filter(r=>r.status==='completed'||r.status==='excluded').map(r=>r.id));
  return run.cases.filter(c=>!done.has(c.id));
}
function errorMessage(error: unknown) {
  return error instanceof Error && /^(Gemini (API key is missing\.|returned HTTP \d{3}|connection failed or timed out\.))$/.test(error.message)
    ? error.message : 'Model request failed or returned invalid fields. Review this case before resuming.';
}

export async function executeRun(run: EvaluationRun, options: RunnerOptions) {
  const {store,evaluator,context,shouldStop}=options;
  const interval=options.requestIntervalMs??4500;
  const maxRetries=options.maxRateRetries??2;
  const maxTemporaryRetries=options.maxTemporaryRetries??2;
  const wait=options.wait??(async(ms:number)=>{
    const until=Date.now()+ms;
    while(!shouldStop()&&Date.now()<until) await new Promise(resolve=>setTimeout(resolve,Math.min(1000,until-Date.now())));
  });
  run.attemptHistory??=run.results.filter(r=>r.status!=='excluded').map(r=>({...r}));
  let lastStart=0;
  function record(result: CaseResult) {
    const index=run.results.findIndex(r=>r.id===result.id);
    if(index<0)run.results.push(result);else run.results[index]=result;
    if(result.status!=='excluded')run.attemptHistory!.push(result);
  }
  async function pause(reason:string,retryAfterMs:number|null=null) {
    run.status='paused';run.pauseReason=reason;run.finishedAt=new Date().toISOString();run.progress=null;
    run.retryNotBefore=retryAfterMs===null?null:new Date(Date.now()+retryAfterMs).toISOString();
    await store.save(run);
  }
  run.pauseReason=null;run.retryNotBefore=null;
  for(const entry of remainingCases(run)) {
    if(shouldStop())break;
    if(entry.excludedFields.length===fields.length) {
      record({id:entry.id,status:'excluded',actual:null,durationMs:0,usage:{},error:null});await store.save(run);continue;
    }
    for(let retry=0;;retry++) {
      if(shouldStop())break;
      const pacing=Math.max(0,lastStart+interval-Date.now());
      if(pacing){run.progress={caseId:entry.id,state:'waiting',nextAttemptAt:new Date(Date.now()+pacing).toISOString(),attempt:retry+1};await store.save(run);await wait(pacing);}
      if(shouldStop())break;
      run.progress={caseId:entry.id,state:'calling',nextAttemptAt:null,attempt:retry+1};await store.save(run);
      const started=Date.now();lastStart=started;
      let completed: CaseResult | undefined;
      try {
        const output=await evaluator(entry,context);
        completed={id:entry.id,status:'completed',actual:answerSchema.parse(output.actual),availabilityAsSaid:output.availabilityAsSaid??null,
          durationMs:Date.now()-started,usage:output.usage,error:null};
      } catch(error) {
        const message=errorMessage(error);
        record({id:entry.id,status:'error',actual:null,durationMs:Date.now()-started,usage:{},error:message});
        await store.save(run);
        if(/HTTP 429/.test(message)) {
          const reported=error instanceof GeminiRateLimitError?error.retryAfterMs:null;
          const delay=Math.max(reported??0,10_000*2**retry);
          if(error instanceof GeminiRateLimitError&&error.dailyQuota){await pause('Gemini reports a daily quota limit. Completed cases are saved. Resume only when your provider quota is available.',reported);return;}
          if(retry>=maxRetries||delay>60_000){await pause('Gemini is still rate-limited. Completed cases are saved; Resume will retry only failed and unfinished cases.',reported??delay);return;}
          run.progress={caseId:entry.id,state:'rate_limited',nextAttemptAt:new Date(Date.now()+delay).toISOString(),attempt:retry+2};
          await store.save(run);await wait(delay);continue;
        }
        if(/HTTP 5\d{2}|connection failed or timed out/.test(message)) {
          const reported=error instanceof TemporaryGeminiError?error.retryAfterMs:null;
          const delay=Math.max(reported??0,5000*2**retry);
          if(retry>=maxTemporaryRetries||delay>60_000){await pause('Gemini is temporarily unavailable or timing out. Completed results are saved. Resume retries only failed or unfinished cases.',reported??delay);return;}
          run.progress={caseId:entry.id,state:'retrying_service',nextAttemptAt:new Date(Date.now()+delay).toISOString(),attempt:retry+2};
          await store.save(run);await wait(delay);continue;
        }
        if(/API key|HTTP (400|401|403|404)/.test(message)) {await pause('Gemini configuration or access needs attention. Fix the issue, then Resume; successful cases will not repeat.');return;}
        break;
      }
      // Persistence errors must not turn a valid model response into a model failure.
      if(completed){record(completed);await store.save(run);break;}
    }
  }
  run.progress=null;run.finishedAt=new Date().toISOString();
  if(shouldStop()){run.status='interrupted';run.pauseReason='Evaluation stopped; successful cases remain saved.';}
  else if(remainingCases(run).length){run.status='paused';run.pauseReason='Some cases failed. Resume retries only failed or unfinished cases.';}
  else{run.status='completed';run.pauseReason=null;}
  await store.save(run);
}
