import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { EvaluationCase } from './dataset.js';
import type { CaseResult } from './scoring.js';

export type EvaluationRun = {
  id: string; createdAt: string; finishedAt: string | null; status: 'running' | 'completed' | 'interrupted' | 'paused';
  configuration: { model:string; promptVersion:string; promptSha256:string; policyVersion:number; scope:string; outputVersion?:number; referenceDateProvided?:boolean };
  datasetSha256: string; cases: EvaluationCase[]; results: CaseResult[];
  promptSnapshot?: string;
  attemptHistory?: CaseResult[];
  resumedAt?: string[];
  pauseReason?: string | null;
  retryNotBefore?: string | null;
  progress?: {caseId:string;state:'calling'|'waiting'|'rate_limited'|'retrying_service';nextAttemptAt:string|null;attempt:number} | null;
};
export class RunStore {
  constructor(readonly directory: string) {}
  async initialize() {
    await mkdir(this.directory, {recursive:true});
    for (const run of await this.list()) if (run.status === 'running') {
      run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
      run.progress = null; run.pauseReason = 'The evaluation server stopped. Saved successful cases will not repeat on Resume.';
      await this.save(run);
    }
  }
  async save(run: EvaluationRun) {
    const target = this.filename(run.id), temporary = target + '.pending';
    await writeFile(temporary, JSON.stringify(run, null, 2) + '\n', {encoding:'utf8',mode:0o600});
    await rename(temporary, target);
  }
  async get(id: string): Promise<EvaluationRun | null> {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    try { return JSON.parse(await readFile(this.filename(id),'utf8')) as EvaluationRun; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async list() {
    const names = await readdir(this.directory);
    const runs: EvaluationRun[] = [];
    for (const name of names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name))) {
      const run = await this.get(name.slice(0,-5)); if (run) runs.push(run);
    }
    return runs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  private filename(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid run ID');
    return path.join(this.directory,id+'.json');
  }
}
export const datasetHash = (cases: EvaluationCase[]) => createHash('sha256').update(JSON.stringify(cases)).digest('hex');
