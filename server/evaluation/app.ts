import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { datasetFromRequest, DatasetError, fields, savedDatasets } from './dataset.js';
import { evaluateCase, modelConfiguration, evaluationPrompt, contextForRun, type EvaluateCase } from './model.js';
import { RunStore, datasetHash, type EvaluationRun } from './store.js';
import { scoreRun } from './scoring.js';
import { executeRun, remainingCases } from './runner.js';
import { registerLocationEvaluation } from './location.js';
import type { Coordinates } from '../providers/coordinates.js';

export async function createEvaluationApp(options: { directory?: string; evaluator?: EvaluateCase; requestIntervalMs?:number; retryWait?:(ms:number)=>Promise<void>; locationDirectory?:string; locate?:(address:string)=>Promise<Coordinates> } = {}) {
  const store = new RunStore(options.directory ?? fileURLToPath(new URL('../../output/evaluation-runs/',import.meta.url)));
  await store.initialize();
  const evaluator = options.evaluator ?? evaluateCase;
  const token = randomBytes(32).toString('hex');
  const app = express();
  let activeRun: EvaluationRun | null = null;
  let activeWork: Promise<void> | null = null;
  let stopping = false;
  const activeId = () => activeRun?.id ?? null;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Referrer-Policy':'no-referrer'});
    const port = req.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.get('host')??'')) return res.status(403).json({error:'This tool is available only through its local laptop URL.'});
    if (!['GET','HEAD'].includes(req.method)) {
      const incoming = req.get('x-evaluation-token')??'';
      const origin = req.get('origin');
      if ((origin && !hosts.some(host=>origin==='http://'+host)) || !/^[a-f0-9]{64}$/.test(incoming)
          || !timingSafeEqual(Buffer.from(incoming),Buffer.from(token))) return res.status(403).json({error:'Reload the local evaluation page before submitting.'});
    }
    next();
  });
  app.use(express.json({limit:'20mb'}));
  const view = (run: EvaluationRun) => ({...run, remainingCases:remainingCases(run).length,
    scores:scoreRun(run.cases,run.results,run.attemptHistory),
    canResume:run.configuration.referenceDateProvided===true&&(!activeRun||activeRun.id===run.id)&&run.status!=='running'&&remainingCases(run).length>0,
    resumeBlockedReason:run.configuration.referenceDateProvided!==true?'This saved run used different date context. Start a new evaluation; the old results remain saved.':null,
    promptChanged:run.configuration.promptSha256!==modelConfiguration.promptSha256});
  function launch(run: EvaluationRun, context: Awaited<ReturnType<typeof contextForRun>>) {
    activeWork=executeRun(run,{store,evaluator,context,shouldStop:()=>stopping,
      requestIntervalMs:options.requestIntervalMs,
      wait:options.retryWait,
    }).catch(async()=>{
      run.status='interrupted';run.finishedAt=new Date().toISOString();run.progress=null;
      run.pauseReason='Evaluation interrupted. Saved successful cases will not repeat on Resume.';
      console.error('evaluation_run_interrupted');
      await store.save(run).catch(()=>console.error('evaluation_result_save_failed'));
    }).finally(()=>{activeRun=null;activeWork=null;});
  }
  app.get('/api/config',(_req,res)=>res.json({token,configuration:modelConfiguration,datasets:savedDatasets,
      activeRunId:activeRun?.id??null,maxCases:100,
    notes:'Local tool. Sends transcripts to Gemini only after Run. No database, phone calls, summary generation or summary scoring.'}));
  app.post('/api/validate',async(req,res)=>{
    const cases = await datasetFromRequest(req.body);
    res.json({cases,total:cases.length,scorableCases:cases.filter(c=>c.excludedFields.length<fields.length).length,
      excludedFields:cases.reduce((n,c)=>n+c.excludedFields.length,0),
      notice:'The reference call date is sent to Gemini to resolve confirmed relative days. Disputed fields remain excluded.'});
  });
  app.get('/api/runs',async(_req,res)=>{
    const runs = await store.list();
    res.json(runs.slice(0,50).map(run=>({id:run.id,createdAt:run.createdAt,status:run.status,
      configuration:run.configuration,datasetSha256:run.datasetSha256,scores:scoreRun(run.cases,run.results,run.attemptHistory)})));
  });
  app.get('/api/runs/:id',async(req,res)=>{
    const run = activeRun?.id===req.params.id?activeRun:await store.get(req.params.id);
    if (!run) return res.status(404).json({error:'Run not found.'});
    if(req.query.download==='true') res.attachment(`transcript-evaluation-${run.id}.json`);
    res.json(view(run));
  });
  app.post('/api/runs',async(req,res)=>{
    if (stopping) return res.status(503).json({error:'Evaluation server is stopping.'});
    if (activeRun) return res.status(409).json({error:'A run is already active. Wait for it to finish.',runId:activeRun.id});
    if (req.body?.confirmApiUsage !== true) throw new DatasetError('Confirm that this run sends transcripts to Gemini and may use API quota or incur charges.');
    const cases = await datasetFromRequest(req.body);
    // Check again after asynchronous file validation so two submissions cannot start together.
    if (activeId()) return res.status(409).json({error:'A run is already active.',runId:activeId()});
    const run: EvaluationRun = {id:randomUUID(),createdAt:new Date().toISOString(),finishedAt:null,status:'running',
      configuration:modelConfiguration,datasetSha256:datasetHash(cases),cases,results:[],promptSnapshot:evaluationPrompt,attemptHistory:[]};
    activeRun = run;
    try { await store.save(run); } catch (error) { activeRun=null; throw error; }
    res.status(202).json(view(run));
    launch(run,await contextForRun(run));
  });
  app.post('/api/runs/:id/resume',async(req,res)=>{
    if(stopping)return res.status(503).json({error:'Evaluation server is stopping.'});
    if(activeId())return res.status(409).json({error:'Another evaluation is active. Wait for it to finish.'});
    if(req.body?.confirmApiUsage!==true)throw new DatasetError('Confirm API usage before resuming.');
    const run=await store.get(req.params.id);if(!run)return res.status(404).json({error:'Run not found.'});
    if(!remainingCases(run).length)return res.status(409).json({error:'This run has no failed or unfinished cases.'});
    if(run.retryNotBefore&&Date.parse(run.retryNotBefore)>Date.now())return res.status(429).json({error:'Gemini asked for a wait. Try Resume after '+new Date(run.retryNotBefore).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' (Asia/Kolkata).'});
    let context;try{context=await contextForRun(run);}catch(error){return res.status(409).json({error:error instanceof Error?error.message:'Original prompt unavailable.'});}
    if(activeId())return res.status(409).json({error:'Another evaluation is active.'});
    activeRun=run;run.status='running';run.finishedAt=null;run.pauseReason=null;run.progress=null;
    run.promptSnapshot=context.prompt;run.resumedAt??=[];run.resumedAt.push(new Date().toISOString());
    try{await store.save(run);}catch(error){activeRun=null;throw error;}
    res.status(202).json(view(run));launch(run,context);
  });
  const locationEvaluation = await registerLocationEvaluation(app, {directory:options.locationDirectory ?? (options.directory ? options.directory+'/location' : undefined),locate:options.locate});
  app.use(express.static(fileURLToPath(new URL('./public/',import.meta.url)),{etag:false,lastModified:false}));
  app.use((error: unknown,_req: express.Request,res: express.Response,_next: express.NextFunction)=>{
    if (error instanceof DatasetError) return res.status(400).json({error:error.message});
    if ((error as {type?:string})?.type==='entity.too.large') return res.status(413).json({error:'Files are too large. Upload a smaller dataset.'});
    if (error instanceof SyntaxError) return res.status(400).json({error:'Invalid JSON request.'});
    console.error('evaluation_request_failed');
    res.status(500).json({error:'Could not process this evaluation request. Check the local terminal.'});
  });
  return {app,store,async stop(){stopping=true;await Promise.all([activeWork,locationEvaluation.stop()]);}};
}
