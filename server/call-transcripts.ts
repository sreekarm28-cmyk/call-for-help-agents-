import { timingSafeEqual } from 'node:crypto';
import { json, type Express, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { resolveCallLanguage } from './call-context-language.js';
import { claimTestCall, testCallContext, testCallSettings } from './test-calls.js';

export function registerCallTranscriptRoute(app: Express, pool: Pool) {
  const authenticate: RequestHandler = (request, response, next) => {
    const token = Buffer.from(process.env.CALL_TRANSCRIPT_TOKEN?.trim() ?? '');
    const header = Buffer.from(request.get('authorization') ?? '');
    const expected = Buffer.concat([Buffer.from('Bearer '), token]);
    if (!token.length || header.length !== expected.length || !timingSafeEqual(header, expected)) {
      response.sendStatus(401);
      return;
    }
    next();
  };

  app.post('/api/internal/test-calls/claim', authenticate, json(), async (request, response) => {
    const supplied: unknown = request.body?.callAttemptId;
    const id = supplied == null ? null : String(supplied);
    if (id !== null && (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) return response.sendStatus(400);
    const call = await claimTestCall(pool, id);
    if (call && 'disabled' in call) return response.status(403).json({ error: 'Enable TEST_CALLS_ENABLED to start test calls.' });
    if (!call) return response.status(204).end();
    return response.json({ callAttemptId: call.id });
  });

  app.get('/api/internal/call-attempts/:id/context', authenticate, async (request, response) => {
    const { id } = request.params;
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) return response.sendStatus(404);
    if (!await testCallSettings()) return response.sendStatus(403);
    const context = await testCallContext(pool, id);
    if (!context) return response.sendStatus(404);
    return response.set('Cache-Control', 'no-store').json(context);
  });

  app.post('/api/internal/call-attempts/:id/outcome', authenticate, json(), async (request, response) => {
    const { id } = request.params;
    const status: unknown = request.body?.status;
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n ||
        (status !== 'failed' && status !== 'no_answer' && status !== 'rejected')) return response.sendStatus(400);
    const result = await pool.query(
      `UPDATE call_attempts SET status = $2, ended_at = COALESCE(ended_at, clock_timestamp())
       WHERE id = $1 AND status IN ('calling', $2) RETURNING id`, [id, status],
    );
    if (!result.rowCount) return response.sendStatus(409);
    return response.json({ status });
  });

  app.get('/api/internal/call-attempts/:id/language', authenticate, async (request, response) => {
    const { id } = request.params;
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) return response.sendStatus(404);
    const { rows: [call] } = await pool.query<{ request_id: string; service_address: string; preferred_language: string | null }>(
      `SELECT r.id AS request_id, r.service_address, r.preferred_language FROM call_attempts c JOIN service_requests r ON r.id = c.request_id
       WHERE c.id = $1`, [id],
    );
    if (!call) return response.sendStatus(404);
    return response.set('Cache-Control', 'no-store').json(
      await resolveCallLanguage(pool, call.request_id, call.service_address, call.preferred_language),
    );
  });

  app.post('/api/internal/call-attempts/:id/transcript', authenticate, json({ limit: '300kb' }), async (request, response) => {
    const { id } = request.params;
    const { transcript } = request.body ?? {};
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n ||
        typeof transcript !== 'string' || !transcript.trim() || transcript.length > 60_000 || transcript.includes('\0')) {
      return response.sendStatus(400);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [call] } = await client.query<{ status: string; transcript: string | null }>(
        `SELECT status, transcript FROM call_attempts
         WHERE id = $1 FOR UPDATE`, [id],
      );
      let status = 409;
      if (!call) status = 404;
      else if (call.transcript === transcript) status = 200;
      else if (['queued', 'calling'].includes(call.status)) {
        await client.query(
          `UPDATE call_attempts SET status = 'transcript_received', transcript = $2, ended_at = clock_timestamp()
           WHERE id = $1`, [id, transcript],
        );
        await client.query('INSERT INTO call_extractions (call_attempt_id) VALUES ($1)', [id]);
        status = 201;
      }
      await client.query('COMMIT');
      return response.sendStatus(status);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
