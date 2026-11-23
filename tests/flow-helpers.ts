import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

export async function waitFor<T>(description: string, check: () => Promise<T | undefined>) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await setTimeout(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

export function startProcess(relativePath: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL(relativePath, import.meta.url)),
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let exited = false;
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => { output += error.message; });
  const done = new Promise<void>((resolve) => child.once('close', () => {
    exited = true;
    resolve();
  }));
  return {
    output: () => output,
    check: () => { if (exited) throw new Error(`${relativePath} exited.\n${output}`); },
    stop: async () => {
      if (!exited) child.kill();
      await done;
    },
  };
}

export type SearchStatus = {
  status: string;
  providerCount: number | null;
  candidateCount: number | null;
  eligibleCount: number | null;
  strictPassCount: number | null;
  shortfall: number | null;
  ratingFallbackUsed: boolean | null;
  ratingCutoff: number | null;
  errorCode: string | null;
};

export type FlowContext = {
  database: pg.Client;
  schema: string;
  baseUrl: string;
  cookie: string;
  env: NodeJS.ProcessEnv & { CALL_TRANSCRIPT_TOKEN: string };
  post: (path: string, body: object, cookie?: string, submissionId?: string) => Promise<Response>;
  startWorker: () => ReturnType<typeof startProcess>;
  requests: { address: string; service?: string; expiredAttempts?: number; expected: Partial<SearchStatus>; path: string; requestId: number }[];
  bookingId: string;
};

export async function withFlow(run: (context: FlowContext) => Promise<void>) {
  config({ quiet: true });
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)) {
    throw new Error('The provider flow test requires a local PostgreSQL URL.');
  }
  const database = new pg.Client({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 5_000 });
  const schema = `provider_flow_test_${randomBytes(8).toString('hex')}`;
  let schemaCreated = false;
  let api: ReturnType<typeof startProcess> | undefined;
  let worker: ReturnType<typeof startProcess> | undefined;
  try {
    await database.connect();
    await database.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    // Migration 001 explicitly names public. Redirect its initial tables to the test schema.
    const initialSchema = readFileSync(new URL('../database/001_initial_schema.sql', import.meta.url), 'utf8');
    await database.query(initialSchema.replace(/\bpublic\./g, `"${schema}".`));
    await runner({
      dbClient: database, schema, migrationsTable: 'pgmigrations', direction: 'up',
      dir: fileURLToPath(new URL('../database/migrations', import.meta.url)),
      ignorePattern: '001_.*', noLock: true, log: () => {},
    });

    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      NODE_OPTIONS: `--import tsx --import ${new URL('./google-mocks.ts', import.meta.url).href}`,
      DATABASE_URL: databaseUrl.toString(),
      GOOGLE_MAPS_API_KEY: 'test-key',
      GOOGLE_API_KEY: 'test-extraction-key',
      CALL_TRANSCRIPT_TOKEN: 'test-transcript-token',
      GOOGLE_GEOCODING_API_KEY: '',
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_PUBLIC_KEY: '',
      API_PORT: '0',
      TEST_CALLS_ENABLED: 'true',
      TEST_PHONE_NUMBER: '+919999900001',
    };
    api = startProcess('../server/index.ts', env);
    const baseUrl = await waitFor<string>('the API to start', async () => {
      api!.check();
      return api!.output().match(/API listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    });
    const post = (path: string, body: object, cookie?: string, submissionId?: string) => fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(submissionId ? { 'Idempotency-Key': submissionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const registration = await post('/api/auth/register', {
      email: 'provider-flow@example.test', password: 'provider-flow-test-password',
    });
    assert.equal(registration.status, 201, await registration.text());
    const cookie = registration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'Registration must return a session cookie.');

    const context: FlowContext = {
      database, schema, baseUrl, cookie, env, post, requests: [], bookingId: '',
      startWorker: () => {
        worker ??= startProcess('../server/scheduler/worker.ts', env);
        return worker;
      },
    };
    await run(context);
  } catch (error) {
    if (api) console.error(api.output());
    if (worker) console.error(worker.output());
    if (schemaCreated) await database.query('ROLLBACK');
    throw error;
  } finally {
    await Promise.all([worker?.stop(), api?.stop()]);
    try {
      if (schemaCreated) await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await database.end();
    }
  }
}
