import type { PoolClient } from 'pg';
import { confirmationAttemptCount, confirmationAttemptLimit, confirmationRetryDelaySeconds, enqueueConfirmation } from './confirmation-policy.js';

// Caller holds the request row lock. This function only queues the first attempt.
export async function queueBookingConfirmation(client: PoolClient, requestId: string) {
  const { rows: [booking] } = await client.query<{ id: string }>(
    `SELECT b.id FROM bookings b
     WHERE b.request_id = $1 AND b.status = 'awaiting_provider_confirmation'
       AND b.confirmation_call_attempt_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM call_attempts WHERE confirmation_booking_id = b.id)`, [requestId],
  );
  if (booking) await enqueueConfirmation(client, requestId, booking.id);
}

export async function advanceBookingConfirmation(client: PoolClient, requestId: string) {
  const { rows: [booking] } = await client.query<{
    id: string; backup_offer_id: string | null; call_status: string; future: boolean;
    attempts: number; attempt_limit: number; retry_window: boolean;
  }>(
    `SELECT b.id, b.backup_offer_id, c.status AS call_status, o.visit_at > clock_timestamp() AS future,
            ${confirmationAttemptCount} AS attempts, ${confirmationAttemptLimit} AS attempt_limit,
            o.visit_at > clock_timestamp() + interval '60 seconds' AS retry_window
     FROM bookings b JOIN provider_offers o ON o.id = b.offer_id AND o.request_id = b.request_id
     JOIN call_attempts original ON original.id = o.call_attempt_id
     JOIN call_attempts c ON c.id = b.confirmation_call_attempt_id
       AND c.confirmation_booking_id = b.id AND c.request_id = b.request_id
       AND c.google_place_id = original.google_place_id
     WHERE b.request_id = $1 AND b.status = 'awaiting_provider_confirmation'
     FOR UPDATE OF b`, [requestId],
  );
  if (booking?.call_status === 'confirmed' && booking.future) {
    await client.query("UPDATE bookings SET status = 'confirmed', status_changed_at = clock_timestamp() WHERE id = $1", [booking.id]);
    await client.query(
      `UPDATE request_providers p SET expires_at = o.visit_at + interval '10 hours'
       FROM provider_offers o JOIN bookings b ON b.offer_id = o.id
       WHERE b.id = $1 AND p.request_id = b.request_id`, [booking.id],
    );
    // No backup is queued: the primary is confirmed.
  } else if (booking && ['no_answer', 'rejected'].includes(booking.call_status) && booking.retry_window && booking.attempts < booking.attempt_limit) {
    await enqueueConfirmation(client, requestId, booking.id, confirmationRetryDelaySeconds);
  } else if (booking && ['declined', 'no_answer', 'rejected'].includes(booking.call_status)) {
    await client.query("UPDATE bookings SET status = 'cancelled', status_changed_at = clock_timestamp() WHERE id = $1", [booking.id]);
    if (booking.backup_offer_id) {
      await client.query(
        `INSERT INTO bookings (request_id, offer_id, confirmation_role)
         SELECT o.request_id, o.id, 'backup' FROM provider_offers o JOIN call_attempts c ON c.id = o.call_attempt_id
         WHERE o.id = $2 AND o.request_id = $1 AND c.status = 'offer_received'
           AND o.visit_at > clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM bookings WHERE offer_id = o.id)
         ON CONFLICT DO NOTHING`, [requestId, booking.backup_offer_id],
      );
    }
  }
  // An unclear answer or an infrastructure failure stays pending; neither triggers backup.
  await queueBookingConfirmation(client, requestId);
}
