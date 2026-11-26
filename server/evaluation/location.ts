import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Express } from 'express';
import { coordinates, type Coordinates } from '../providers/coordinates.js';
import { verifyServiceAddress, UnresolvedAddressError } from '../providers/geocode-address.js';
import { distanceMetres, locationToleranceMetres } from '../requests/location.js';
import { DatasetError } from './dataset.js';

const caseSchema = z.object({ id: z.string().trim().min(1).max(100), address: z.string().trim().min(1).max(500),
  expectedResolvable: z.boolean().default(true), expectedLocation: coordinates.nullable().optional(),
}).superRefine((value, context) => {
  if (value.expectedResolvable && !value.expectedLocation) context.addIssue({code:'custom',message:'A valid-address case needs reference coordinates.'});
});
export function validateLocationCases(value: unknown) {
  const parsed = z.array(caseSchema).min(1).max(100).safeParse(value);
  if (!parsed.success) throw new DatasetError('Supply 1–100 cases with a unique id, address, expectedResolvable, and reference latitude/longitude for valid addresses.');
  if (new Set(parsed.data.map(entry => entry.id)).size !== parsed.data.length) throw new DatasetError('Location case IDs must be unique.');
  return parsed.data;
}
type LocationCase = ReturnType<typeof validateLocationCases>[number];
type LocationResult = { id: string; status: 'located' | 'unresolved' | 'error'; actual: Coordinates | null; distanceMetres: number | null; durationMs: number; error: string | null };
type LocationRun = { id: string; createdAt: string; status: 'running' | 'completed' | 'interrupted'; thresholdMetres: number; cases: LocationCase[]; results: LocationResult[] };
export function scoreLocation(cases: LocationCase[], results: LocationResult[]) {
  const byId = new Map(results.map(result => [result.id, result]));
  const positives = cases.filter(entry => entry.expectedResolvable), negatives = cases.filter(entry => !entry.expectedResolvable);
  const measured = positives.map(entry => byId.get(entry.id)?.distanceMetres).filter((value): value is number => value !== undefined && value !== null).sort((a,b) => a-b);
  const fraction = (numerator: number, denominator: number) => ({ numerator, denominator, percent: denominator ? Math.round(numerator / denominator * 10000) / 100 : null });
  const located = results.filter(result => result.status === 'located').length;
  return {
    withinTarget: fraction(positives.filter(entry => { const value = byId.get(entry.id)?.distanceMetres; return value !== null && value !== undefined && value <= locationToleranceMetres; }).length, positives.length),
    lookupSuccess: fraction(located, cases.length),
    falseAcceptance: fraction(negatives.filter(entry => byId.get(entry.id)?.status === 'located').length, negatives.length),
    correctRejection: fraction(negatives.filter(entry => byId.get(entry.id)?.status === 'unresolved').length, negatives.length),
    medianDistanceMetres: measured.length ? (measured[Math.floor((measured.length-1)/2)] + measured[Math.floor(measured.length/2)]) / 2 : null,
    meanResponseMs: results.length ? results.reduce((sum,result) => sum+result.durationMs,0) / results.length : null,
    errors: results.filter(result => result.status === 'error').length, finished: results.length, total: cases.length,
  };
}

export async function registerLocationEvaluation(app: Express, options: {
  directory?: string; locate?: (address: string) => Promise<Coordinates>;
} = {}) {
  const directory = options.directory ?? fileURLToPath(new URL('../../output/location-evaluation-runs/', import.meta.url));
  await mkdir(directory, {recursive:true});
  const locate = options.locate ?? verifyServiceAddress;
  let active: LocationRun | null = null, work: Promise<void> | null = null, stopping = false;
  const save = async (run: LocationRun) => {
    const target = path.join(directory, run.id+'.json');
    await writeFile(target+'.pending', JSON.stringify(run, null, 2), 'utf8'); await rename(target+'.pending', target);
  };
  const load = async (id: string): Promise<LocationRun | null> => {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(directory,id+'.json'),'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const list = async () => {
    const runs: LocationRun[] = [];
    for (const name of await readdir(directory)) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
      const run = await load(name.slice(0,-5)); if (run) runs.push(run);
    }
    return runs.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  };
  for (const run of await list()) if (run.status === 'running') { run.status='interrupted'; await save(run); }
  const view = (run: LocationRun) => ({...run,scores:scoreLocation(run.cases,run.results)});
  app.get('/api/location/dataset', async (_req,res) => {
    res.json(JSON.parse(await readFile(new URL('../../evaluation/location-cases.json',import.meta.url),'utf8')));
  });
  app.post('/api/location/validate', (req,res) => { const cases=validateLocationCases(req.body?.cases); res.json({total:cases.length}); });
  app.get('/api/location/runs', async (_req,res) => res.json((await list()).slice(0,50).map(view)));
  app.get('/api/location/runs/:id', async (req,res) => {
    const run = active?.id === req.params.id ? active : await load(req.params.id);
    if (!run) return res.status(404).json({error:'Location run not found.'});
    if (req.query.download === 'true') res.attachment('location-evaluation-'+run.id+'.json');
    res.json(view(run));
  });
  app.post('/api/location/runs', async (req,res) => {
    if (stopping) return res.status(503).json({error:'Evaluation server is stopping.'});
    if (active) return res.status(409).json({error:'A location evaluation is already running.',runId:active.id});
    if (req.body?.confirmApiUsage !== true) throw new DatasetError('Confirm Google API usage before running location evaluation.');
    const cases = validateLocationCases(req.body?.cases);
    const run: LocationRun = {id:randomUUID(),createdAt:new Date().toISOString(),status:'running',thresholdMetres:locationToleranceMetres,cases,results:[]};
    active=run;
    try { await save(run); } catch (error) { active=null; throw error; }
    res.status(202).json(view(run));
    work=(async () => {
      for (const entry of cases) {
        if (stopping) { run.status='interrupted'; break; }
        const started=performance.now();
        let result: LocationResult;
        try {
          const output=await locate(entry.address);
          const actual=coordinates.parse(output);
          result={id:entry.id,status:'located',actual,distanceMetres:entry.expectedLocation ? distanceMetres(entry.expectedLocation,actual) : null,durationMs:performance.now()-started,error:null};
        } catch (error) {
          const unresolved=error instanceof UnresolvedAddressError;
          result={id:entry.id,status:unresolved?'unresolved':'error',actual:null,distanceMetres:null,durationMs:performance.now()-started,
            error:unresolved?'Address could not be verified.':'Address lookup unavailable. Check API configuration or retry later.'};
        }
        run.results.push(result); await save(run);
      }
      if (!stopping) run.status='completed';
      await save(run);
    })().catch(async () => { run.status='interrupted'; console.error('location_evaluation_interrupted'); await save(run).catch(()=>{}); })
      .finally(()=>{active=null;work=null;});
  });
  return {async stop(){stopping=true;await work;}};
}
