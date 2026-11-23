import type { Pool } from 'pg';
import { confirmationAttemptCount, confirmationAttemptLimit, enqueueConfirmation } from './bookings/confirmation-policy.js';

// Both the UI and the transaction use the same eligibility rule (aliases c/e).
export const retryableConfirmation = `(${confirmationAttemptCount} < ${confirmationAttemptLimit} AND (c.status = 'failed' OR
  (c.status = 'transcript_received' AND (e.extraction_status = 'failed' OR
    (e.extraction_status = 'completed' AND e.confirmation_decision = 'needs_clarification')))))`;

export async function retryBookingConfirmation(
  pool: Pool, userId: string, requestId: string, bookingId: string, previousAttemptId: string,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query('SELECT id FROM service_requests WHERE id = $1 AND user_id = $2 FOR UPDATE', [requestId, userId]);
    const { rows: [booking] } = owner.rowCount ? await client.query<{
      status: string; future: boolean; call_id: string | null;
      retryable: boolean | null;
      attempts: number; attempt_limit: number;
    }>(
      `SELECT b.status, o.visit_at > clock_timestamp() AS future, c.id AS call_id,
              ${retryableConfirmation} AS retryable,
              ${confirmationAttemptCount} AS attempts, ${confirmationAttemptLimit} AS attempt_limit
       FROM bookings b JOIN provider_offers o ON o.id = b.offer_id AND o.request_id = b.request_id
       LEFT JOIN call_attempts c ON c.id = b.confirmation_call_attempt_id
       LEFT JOIN call_extractions e ON e.call_attempt_id = c.id
       WHERE b.id = $1 AND b.request_id = $2 FOR UPDATE OF b`, [bookingId, requestId],
    ) : { rows: [] };
    let result: { status: number; body: { error?: string; callAttemptId?: string } };
    if (!booking) result = { status: 404, body: { error: 'Booking not found.' } };
    else if (booking.status !== 'awaiting_provider_confirmation' || !booking.future) {
      result = { status: 409, body: { error: 'This booking is no longer awaiting confirmation or its visit time has passed.' } };
    } else if (booking.call_id && booking.call_id !== previousAttemptId) {
      // Replaying the same click cannot enqueue another call, even if the first retry has finished.
      result = { status: 200, body: { callAttemptId: booking.call_id } };
    } else if (booking.attempts >= booking.attempt_limit) {
      result = { status: 409, body: { error: `The ${booking.attempt_limit}-attempt confirmation limit has been reached.` } };
    } else if (!booking.retryable || !booking.call_id) {
      result = { status: 409, body: { error: 'Wait for the current call and its review to finish before retrying.' } };
    } else if ((await client.query(
      "SELECT 1 FROM call_attempts WHERE request_id = $1 AND status IN ('queued', 'calling')", [requestId],
    )).rowCount) {
      result = { status: 409, body: { error: 'A call is already queued or in progress for this request.' } };
    } else {
      const { rows: [call] } = await enqueueConfirmation(client, requestId, bookingId);
      result = call ? { status: 201, body: { callAttemptId: call.id } }
        : { status: 409, body: { error: 'The attempt limit was reached or the visit time is no longer available.' } };
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
