import { setTimeout } from 'node:timers/promises';
import { extractTranscript } from '../transcript-extraction.js';
import { extractConfirmation, type ConfirmationTerms } from '../confirmation-extraction.js';
import { advanceBookingConfirmation } from '../bookings/booking-confirmation.js';
import { observe } from '../observability.js';
import { pool } from './database.js';

const maxAttempts = 3;

async function processTranscript() {
  await pool.query(
    `UPDATE call_extractions SET extraction_status = 'failed', lease_expires_at = NULL
     WHERE extraction_status = 'pending' AND attempt_count >= $1 AND lease_expires_at <= clock_timestamp()`,
    [maxAttempts],
  );
  const { rows: [job] } = await pool.query<{
    call_attempt_id: string; attempt_count: number; transcript: string; called_at: Date; request_id: string;
    confirmation_booking_id: string | null;
  }>(
    `WITH next AS (
       SELECT call_attempt_id FROM call_extractions WHERE extraction_status = 'pending'
         AND attempt_count < $1 AND available_at <= clock_timestamp()
         AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
       ORDER BY available_at, call_attempt_id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE call_extractions e
     SET attempt_count = e.attempt_count + 1, lease_expires_at = clock_timestamp() + interval '90 seconds'
     FROM next JOIN call_attempts c ON c.id = next.call_attempt_id
     WHERE e.call_attempt_id = next.call_attempt_id
     RETURNING e.call_attempt_id, e.attempt_count, c.transcript, c.request_id, c.confirmation_booking_id,
               COALESCE(c.started_at, c.ended_at, e.created_at) AS called_at`,
    [maxAttempts],
  );
  if (!job) return;

  const fence = [job.call_attempt_id, job.attempt_count];
  try {
    let confirmation: Awaited<ReturnType<typeof extractConfirmation>> | null = null;
    if (job.confirmation_booking_id) {
      const { rows: [agreed] } = await pool.query<ConfirmationTerms>(
        `SELECT (o.visit_at AT TIME ZONE 'Asia/Kolkata')::date::text AS "visitDate",
                to_char(o.visit_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS "visitTime",
                o.visit_fee AS "visitFee", o.repair_cost_notes AS "repairCostNotes",
                e.fee_covers AS "feeCovers", e.repair_fee_min AS "repairFeeMin", e.repair_fee_max AS "repairFeeMax"
         FROM bookings b JOIN provider_offers o ON o.id = b.offer_id AND o.request_id = b.request_id
         LEFT JOIN call_extractions e ON e.call_attempt_id = o.call_attempt_id
         WHERE b.id = $1 AND b.request_id = $2`, [job.confirmation_booking_id, job.request_id],
      );
      if (!agreed) throw new Error('Confirmation booking not found.');
      confirmation = await observe('Process booking confirmation', {
        requestId: job.request_id, callAttemptId: job.call_attempt_id,
      }, () => extractConfirmation(job.transcript, agreed));
    }
    const terms = confirmation ? {
      provider_response: confirmation.decision === 'declined' ? 'declined' : 'needs_clarification',
      visit_fee: confirmation.visit_fee, visit_date: confirmation.visit_date, visit_time: confirmation.visit_time,
      summary: confirmation.summary, evidence: confirmation.evidence,
      fee_covers: null, repair_fee_min: null, repair_fee_max: null, repair_cost_notes: null, availability_as_said: null,
    } : await observe('Process call transcript', {
      requestId: job.request_id,
      callAttemptId: job.call_attempt_id,
      attempt: job.attempt_count,
    }, () => extractTranscript(job.transcript, job.called_at));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [job.request_id]);
      const saved = await client.query(
        `UPDATE call_extractions
         SET extraction_status = 'completed', lease_expires_at = NULL, extracted_at = clock_timestamp(),
             provider_response = $3, visit_fee = $4, fee_covers = $5, repair_fee_min = $6,
             repair_fee_max = $7, repair_cost_notes = $8, visit_date = $9,
             visit_time = $10, availability_as_said = $11, summary = $12, evidence = $13,
             confirmation_decision = $14
         WHERE call_attempt_id = $1 AND attempt_count = $2 AND extraction_status = 'pending'
           AND lease_expires_at > clock_timestamp()`,
        [...fence, terms.provider_response, terms.visit_fee, terms.fee_covers, terms.repair_fee_min,
          terms.repair_fee_max, terms.repair_cost_notes, terms.visit_date, terms.visit_time,
          terms.availability_as_said, terms.summary, JSON.stringify(terms.evidence), confirmation?.decision ?? null],
      );
      if (saved.rowCount && confirmation) {
        await client.query(
          `UPDATE call_attempts SET summary = $2, status = $3
           WHERE id = $1 AND status = 'transcript_received'`,
          [job.call_attempt_id, confirmation.summary, confirmation.decision === 'needs_clarification'
            ? 'transcript_received' : confirmation.decision],
        );
        await advanceBookingConfirmation(client, job.request_id);
      } else if (saved.rowCount) {
        await client.query(
          `INSERT INTO provider_offers (request_id, call_attempt_id, visit_at, visit_fee, repair_cost_notes)
           SELECT c.request_id, c.id, (e.visit_date + e.visit_time) AT TIME ZONE 'Asia/Kolkata',
                  e.visit_fee, e.repair_cost_notes
           FROM call_extractions e JOIN call_attempts c ON c.id = e.call_attempt_id
           WHERE c.id = $1 AND c.confirmation_booking_id IS NULL
             AND c.status = 'transcript_received' AND e.provider_response = 'offer_received'
             AND e.visit_fee IS NOT NULL AND (e.visit_date + e.visit_time) AT TIME ZONE 'Asia/Kolkata' > clock_timestamp()
           ON CONFLICT (call_attempt_id) DO NOTHING`, [job.call_attempt_id],
        );
        await client.query(
          `UPDATE call_attempts c SET summary = e.summary, status = CASE
             WHEN EXISTS (SELECT 1 FROM provider_offers o WHERE o.call_attempt_id = c.id) THEN 'offer_received'
             WHEN e.provider_response IN ('declined', 'no_answer') THEN e.provider_response
             ELSE c.status END
           FROM call_extractions e WHERE c.id = $1 AND e.call_attempt_id = c.id
             AND c.status = 'transcript_received'`, [job.call_attempt_id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch {
    console.error('call_extraction_attempt_failed', { callAttemptId: job.call_attempt_id, attempt: job.attempt_count });
    await pool.query(
      `UPDATE call_extractions SET extraction_status = CASE WHEN attempt_count >= $3 THEN 'failed' ELSE 'pending' END,
              lease_expires_at = NULL, available_at = clock_timestamp() + interval '5 seconds' * attempt_count
       WHERE call_attempt_id = $1 AND attempt_count = $2 AND extraction_status = 'pending'
         AND lease_expires_at > clock_timestamp()`, [...fence, maxAttempts],
    );
  }
}

export async function runExtractionWorker(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await processTranscript();
    } catch {
      console.error('call_extraction_cycle_failed');
    }
    await setTimeout(2_000, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}
