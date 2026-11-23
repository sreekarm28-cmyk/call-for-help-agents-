import type { PoolClient } from 'pg';

export const confirmationAttemptLimit = `(CASE b.confirmation_role WHEN 'backup' THEN 2 ELSE 3 END)`;
export const confirmationAttemptCount = `(SELECT count(*)::int FROM call_attempts history
  WHERE history.confirmation_booking_id = b.id AND (history.status <> 'cancelled' OR history.started_at IS NOT NULL))`;
export const confirmationRetryDelaySeconds = 60;

// Caller holds the service request lock. Queued attempts reserve a slot too.
export async function enqueueConfirmation(client: PoolClient, requestId: string, bookingId: string, delaySeconds = 0) {
  return client.query<{ id: string }>(
    `WITH inserted AS (
       INSERT INTO call_attempts (request_id, google_place_id, confirmation_booking_id, available_at)
       SELECT b.request_id, original.google_place_id, b.id, clock_timestamp() + $3 * interval '1 second'
       FROM bookings b JOIN provider_offers o ON o.id = b.offer_id AND o.request_id = b.request_id
       JOIN call_attempts original ON original.id = o.call_attempt_id
       WHERE b.id = $2 AND b.request_id = $1 AND b.status = 'awaiting_provider_confirmation'
         AND o.visit_at > clock_timestamp() + $3 * interval '1 second'
         AND ${confirmationAttemptCount} < ${confirmationAttemptLimit}
         AND NOT EXISTS (SELECT 1 FROM call_attempts WHERE request_id = $1 AND status IN ('queued', 'calling'))
       RETURNING id, confirmation_booking_id)
     UPDATE bookings b SET confirmation_call_attempt_id = inserted.id
     FROM inserted WHERE b.id = inserted.confirmation_booking_id RETURNING inserted.id`,
    [requestId, bookingId, delaySeconds],
  );
}
