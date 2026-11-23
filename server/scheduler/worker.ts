import { setTimeout } from 'node:timers/promises';
import { geocodeServiceAddress, UnresolvedAddressError } from '../providers/geocode-address.js';
import { searchProvidersAt } from '../providers/search-providers.js';
import { TemporaryGoogleError } from '../providers/google-request.js';
import { pool } from './database.js';
import { runExtractionWorker } from './extraction-worker.js';
import { observe } from '../observability.js';
import { shutdownTracing } from '../instrumentation.js';
import type { Coordinates } from '../providers/coordinates.js';
import { advanceOutreach, queueNextProvider, requestedShortlistDeadline } from './outreach.js';

type Job = { id: string; request_id: string; attempt_count: number };
type RequestDetails = {
  service_type: string; custom_service: string | null; service_address: string;
  latitude: number | null; longitude: number | null;
};
const maxAttempts = 3;
const leaseSeconds = 120;

const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());

async function runDueJob() {
  await pool.query(
    `WITH expired_jobs AS (
       SELECT id FROM scheduled_jobs
       WHERE status = 'running' AND lease_expires_at <= CURRENT_TIMESTAMP
         AND attempt_count >= $1 AND request_id IS NOT NULL
       FOR UPDATE SKIP LOCKED
     ), failed_jobs AS (
       UPDATE scheduled_jobs AS job SET status = 'failed', lease_expires_at = NULL
       FROM expired_jobs WHERE job.id = expired_jobs.id
       RETURNING job.request_id, job.id
     )
     INSERT INTO request_events (request_id, event_type, status, actor, started_at, ended_at, message, metadata, search_job_id)
     SELECT request_id, 'provider_search', 'failed', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
            'Provider search timed out after multiple attempts.', '{"errorCode":"search_timed_out"}'::jsonb, id
     FROM failed_jobs`,
    [maxAttempts],
  );
  if (shutdown.signal.aborted) return;

  // A single SQL statement locks and claims one job before returning it.
  const { rows: [job] } = await pool.query<Job>(
    `WITH due_job AS (
       SELECT id FROM scheduled_jobs
       WHERE ((status = 'pending' AND run_at <= CURRENT_TIMESTAMP)
           OR (status = 'running' AND lease_expires_at <= CURRENT_TIMESTAMP))
         AND attempt_count < $1 AND request_id IS NOT NULL
       ORDER BY run_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE scheduled_jobs AS job
     SET status = 'running', attempt_count = job.attempt_count + 1,
         lease_expires_at = CURRENT_TIMESTAMP + $2 * INTERVAL '1 second'
     FROM due_job
     WHERE job.id = due_job.id
     RETURNING job.id, job.request_id, job.attempt_count`,
    [maxAttempts, leaseSeconds],
  );

  if (!job) return;

  const startedAt = new Date();
  let message = 'Provider search completed.';
  let metadata: Record<string, unknown> = {};
  let status: 'completed' | 'failed' | 'pending' = 'completed';
  console.log('scheduler_job_started', { jobId: job.id, requestId: job.request_id, attempt: job.attempt_count });
  const { rows: [request] } = await pool.query<RequestDetails>(
    'SELECT service_type, custom_service, service_address, latitude, longitude FROM service_requests WHERE id = $1',
    [job.request_id],
  );
  if (!request) return; // Deleting the request also deletes its job.
  const { rows: attempted } = await pool.query<{ google_place_id: string }>(
    `SELECT DISTINCT google_place_id FROM call_attempts WHERE request_id = $1
     AND (started_at IS NOT NULL OR status IN ('transcript_received', 'no_answer', 'declined', 'offer_received', 'failed'))`,
    [job.request_id],
  );
  let resolvedLocation: Coordinates | undefined;
  try {
    const center = request.latitude !== null && request.longitude !== null
      ? { latitude: request.latitude, longitude: request.longitude }
      : await observe('Locate service area', {
        requestId: job.request_id, jobId: job.id,
      }, () => geocodeServiceAddress(request.service_address));
    resolvedLocation = center;
    const search = await observe('Find suitable service providers', {
      requestId: job.request_id, jobId: job.id, attempt: job.attempt_count,
    }, () => searchProvidersAt(
      request.custom_service ?? request.service_type,
      center,
      undefined,
      request.service_type === 'other',
      attempted.map(({ google_place_id }) => google_place_id),
    ));
    const placeIds = [...new Set(search.selected.map((provider) => provider.placeId))];
    message = `Provider search shortlisted ${placeIds.length} of ${search.fetched} listings.`;
    metadata = {
      providerCount: placeIds.length,
      placeIds,
      candidateCount: search.fetched,
      strictPassCount: search.strictPassCount,
      eligibleCount: search.eligibleCount,
      shortfall: search.shortfall,
      ratingFallbackUsed: search.ratingCutoff !== 4,
      ratingCutoff: search.ratingCutoff,
    };
  } catch (error) {
    const retry = error instanceof TemporaryGoogleError && job.attempt_count < maxAttempts;
    status = retry ? 'pending' : 'failed';
    message = retry ? 'Google is temporarily unavailable. Search will retry.'
      : error instanceof UnresolvedAddressError ? error.message : 'Provider search failed.';
    metadata = {
      errorCode: retry ? 'google_temporarily_unavailable'
        : error instanceof UnresolvedAddressError ? 'address_unresolved' : 'search_failed',
      attempt: job.attempt_count,
    };
  }

  const endedAt = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [job.request_id]);
    const finished = await client.query(
      `UPDATE scheduled_jobs SET status = $2, lease_expires_at = NULL,
         run_at = CASE WHEN $2 = 'pending' THEN clock_timestamp() + $4 * interval '1 second' ELSE run_at END
       WHERE id = $1 AND status = 'running' AND attempt_count = $3
         AND lease_expires_at > clock_timestamp()`, [job.id, status, job.attempt_count, 2 ** job.attempt_count],
    );
    if (finished.rowCount) {
      if (status === 'completed') {
        await client.query(
          `UPDATE service_requests SET latitude = $2, longitude = $3
           WHERE id = $1 AND latitude IS NULL AND longitude IS NULL`,
          [job.request_id, resolvedLocation?.latitude, resolvedLocation?.longitude],
        );
        await client.query('DELETE FROM request_providers WHERE request_id = $1', [job.request_id]);
        await client.query(
          `INSERT INTO request_providers (request_id, google_place_id, rank, expires_at)
           SELECT r.id, place_id, position::integer,
                  GREATEST(${requestedShortlistDeadline}, clock_timestamp() + interval '10 hours')
           FROM service_requests r CROSS JOIN unnest($2::text[]) WITH ORDINALITY AS ranked(place_id, position)
           WHERE r.id = $1`, [job.request_id, metadata.placeIds ?? []],
        );
      }
      await client.query(
        `INSERT INTO request_events (request_id, event_type, status, actor, started_at, ended_at, duration_ms, message, metadata, search_job_id)
         VALUES ($1, 'provider_search', $2, 'system', $3, $4, $5, $6, $7, $8)`,
        [job.request_id, status, startedAt, endedAt, endedAt.getTime() - startedAt.getTime(), message, metadata, job.id],
      );
      if (status === 'completed') await queueNextProvider(client, job.request_id);
    }
    await client.query('COMMIT');
    if (finished.rowCount) console.log(`Job #${job.id} ${status}: ${message}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runWorkerCycle() {
  await pool.query(
    `UPDATE call_attempts c SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP
     WHERE c.status = 'queued' AND (
       (c.confirmation_booking_id IS NULL AND NOT EXISTS (
         SELECT 1 FROM request_providers p WHERE p.request_id = c.request_id
           AND p.google_place_id = c.google_place_id AND p.expires_at > CURRENT_TIMESTAMP
       )) OR (c.confirmation_booking_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM bookings b JOIN provider_offers o ON o.id = b.offer_id
         WHERE b.id = c.confirmation_booking_id AND b.confirmation_call_attempt_id = c.id
           AND b.status = 'awaiting_provider_confirmation'
           AND o.visit_at > CURRENT_TIMESTAMP
       )))`,
  );
  await pool.query('DELETE FROM request_providers WHERE expires_at <= CURRENT_TIMESTAMP');
  await runDueJob();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `SELECT r.id FROM service_requests r WHERE
        (r.collect_offers AND NOT EXISTS (SELECT 1 FROM request_provider_choices WHERE request_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM call_attempts c
          WHERE c.request_id = r.id AND c.status IN ('queued', 'calling'))
        AND EXISTS (SELECT 1 FROM request_providers p
          WHERE p.request_id = r.id AND p.expires_at > CURRENT_TIMESTAMP
            AND NOT EXISTS (SELECT 1 FROM call_attempts c WHERE c.request_id = r.id
              AND c.google_place_id = p.google_place_id AND (c.status <> 'cancelled' OR c.started_at IS NOT NULL))))
        OR EXISTS (SELECT 1 FROM bookings b JOIN provider_offers o ON o.id = b.offer_id
          LEFT JOIN call_attempts c ON c.id = b.confirmation_call_attempt_id
          WHERE b.request_id = r.id AND b.status = 'awaiting_provider_confirmation'
            AND o.visit_at > CURRENT_TIMESTAMP
            AND (c.id IS NULL OR c.status IN ('confirmed', 'declined', 'no_answer', 'rejected')))
      ORDER BY r.id LIMIT 25 FOR UPDATE SKIP LOCKED`,
    );
    for (const { id } of rows) await advanceOutreach(client, id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const extractionWorker = runExtractionWorker(shutdown.signal);
try {
  console.log('Scheduler worker started. Checking for due jobs every 2 seconds.');
  let consecutiveFailures = 0;
  while (!shutdown.signal.aborted) {
    try {
      await runWorkerCycle();
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      console.error('scheduler_cycle_failed', { consecutiveFailures });
    }
    const delay = 2_000 * 2 ** Math.min(consecutiveFailures, 4);
    await setTimeout(delay, undefined, { signal: shutdown.signal });
  }
} catch (error) {
  if (!(error instanceof Error && error.name === 'AbortError' && shutdown.signal.aborted)) {
    console.error('scheduler_worker_stopped');
    process.exitCode = 1;
  }
} finally {
  shutdown.abort();
  await extractionWorker;
  await Promise.all([shutdownTracing(), pool.end()]);
}
