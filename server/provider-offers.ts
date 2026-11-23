import type { Pool } from 'pg';
import { fetchPlaceDisplay } from './providers/place-display';
import { queueNextProvider, queueProviderSearch } from './scheduler/outreach';
import { queueBookingConfirmation } from './bookings/booking-confirmation';
import { retryableConfirmation } from './confirmation-retry';
import { latestProviderCall, recallBlockedReason } from './provider-recall';
import { confirmationAttemptCount, confirmationAttemptLimit } from './bookings/confirmation-policy';

type Offer = {
  id: string;
  callAttemptId: string;
  placeId: string;
  visitAt: Date | null;
  visitFee: string | null;
  feeCovers: string | null;
  repairFeeMin: string | null;
  repairFeeMax: string | null;
  visitDate: string | null;
  visitTime: string | null;
  availabilityAsSaid: string | null;
  providerResponse: string | null;
  extractionStatus: 'pending' | 'completed' | 'failed' | null;
  repairCostNotes: string | null;
  summary: string | null;
  transcript: string | null;
  selectable: boolean;
};

type Booking = { id: string; offerId: string; backupOfferId: string | null; status: string };

export async function listOffers(pool: Pool, requestId: string, includeDetails: boolean, includeTranscript: boolean) {
  const [{ rows }, { rows: [progress] }, { rows: [booking] }, { rows: [preferences] }] = await Promise.all([
    pool.query<Offer>(
      `SELECT COALESCE(o.id::text, 'call-' || c.id) AS id, c.id AS "callAttemptId",
              c.google_place_id AS "placeId", o.visit_at AS "visitAt",
              COALESCE(o.visit_fee, e.visit_fee) AS "visitFee", e.fee_covers AS "feeCovers",
              e.repair_fee_min AS "repairFeeMin", e.repair_fee_max AS "repairFeeMax",
              e.visit_date::text AS "visitDate", to_char(e.visit_time, 'HH24:MI') AS "visitTime",
              e.availability_as_said AS "availabilityAsSaid", e.provider_response AS "providerResponse",
              e.extraction_status AS "extractionStatus",
              COALESCE(o.repair_cost_notes, e.repair_cost_notes) AS "repairCostNotes",
              COALESCE(e.summary, c.summary) AS summary,
              CASE WHEN $2 OR e.provider_response = 'needs_clarification' THEN c.transcript END AS transcript,
              COALESCE(o.visit_at > CURRENT_TIMESTAMP AND b.id IS NULL, false) AS selectable,
              c.status AS "callStatus", ${recallBlockedReason} AS "recallBlockedReason"
       FROM call_attempts c
       JOIN service_requests r ON r.id = c.request_id
       LEFT JOIN request_providers p ON p.request_id = c.request_id AND p.google_place_id = c.google_place_id
       LEFT JOIN call_extractions e ON e.call_attempt_id = c.id
       LEFT JOIN provider_offers o ON o.call_attempt_id = c.id AND c.status = 'offer_received'
       LEFT JOIN bookings b ON b.offer_id = o.id
       WHERE c.request_id = $1 AND c.confirmation_booking_id IS NULL
         AND ${latestProviderCall}
         AND (e.call_attempt_id IS NOT NULL OR o.id IS NOT NULL OR c.status IN ('calling', 'failed', 'no_answer', 'declined')
           OR (c.status = 'queued' AND EXISTS (SELECT 1 FROM call_attempts previous
             WHERE previous.request_id = c.request_id AND previous.google_place_id = c.google_place_id
               AND previous.id < c.id AND previous.confirmation_booking_id IS NULL)))
       ORDER BY c.id`, [requestId, includeTranscript],
    ),
    pool.query<{ shortlisted: number; attempted: number; inProgress: boolean }>(
      `SELECT (SELECT count(*)::int FROM request_providers WHERE request_id = $1 AND expires_at > CURRENT_TIMESTAMP) AS shortlisted,
              count(DISTINCT google_place_id) FILTER (WHERE status NOT IN ('queued', 'cancelled') AND confirmation_booking_id IS NULL)::int AS attempted,
              COALESCE(bool_or(status IN ('queued', 'calling')), false)
                OR EXISTS (SELECT 1 FROM call_extractions e JOIN call_attempts c ON c.id = e.call_attempt_id
                           WHERE c.request_id = $1 AND e.extraction_status = 'pending')
                OR EXISTS (SELECT 1 FROM scheduled_jobs WHERE request_id = $1 AND status IN ('pending', 'running')) AS "inProgress"
       FROM call_attempts WHERE request_id = $1`, [requestId],
    ),
    pool.query<Booking>(
      `SELECT b.id, b.offer_id AS "offerId", b.backup_offer_id AS "backupOfferId", b.status,
              CASE WHEN c.id IS NOT NULL THEN json_build_object(
                'callAttemptId', c.id::text, 'status', c.status, 'decision', e.confirmation_decision,
                'extractionStatus', e.extraction_status,
                'attemptCount', ${confirmationAttemptCount}, 'attemptLimit', ${confirmationAttemptLimit},
                'availableAt', c.available_at,
                'transcript', CASE WHEN e.confirmation_decision = 'needs_clarification' OR $2 THEN c.transcript END,
                'canRetry', COALESCE(b.status = 'awaiting_provider_confirmation' AND o.visit_at > clock_timestamp()
                  AND ${retryableConfirmation}
                  AND NOT EXISTS (SELECT 1 FROM call_attempts active WHERE active.request_id = b.request_id
                    AND active.status IN ('queued', 'calling')), false)) END AS confirmation
       FROM bookings b JOIN provider_offers o ON o.id = b.offer_id
       LEFT JOIN call_attempts c ON c.id = b.confirmation_call_attempt_id
       LEFT JOIN call_extractions e ON e.call_attempt_id = c.id
       WHERE b.request_id = $1 AND b.status IN ('awaiting_provider_confirmation', 'confirmed')`, [requestId, includeTranscript],
    ),
    pool.query(`SELECT primary_place_id AS "primaryPlaceId",backup_place_id AS "backupPlaceId"
      FROM request_provider_choices WHERE request_id=$1`, [requestId]),
  ]);
  const details = new Map<string, Awaited<ReturnType<typeof fetchPlaceDisplay>>>();
  if (includeDetails) {
    await Promise.all([...new Set(rows.map((offer) => offer.placeId))].slice(0, 5).map(async (id) => {
      details.set(id, await fetchPlaceDisplay(id, true).catch(() => null));
    }));
  }
  return { offers: rows.map((offer) => ({ ...offer, provider: details.get(offer.placeId) ?? null })), progress, booking, preferences };
}

export async function selectOffer(pool: Pool, userId: string, requestId: string, offerId: string, backupOfferId: string | null = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize selections and future call dispatch on the request row.
    const request = await client.query(
      'SELECT id FROM service_requests WHERE id = $1 AND user_id = $2 FOR UPDATE', [requestId, userId],
    );
    const offer = request.rowCount && await client.query<{ available: boolean }>(
      `SELECT o.visit_at > clock_timestamp() AS available
       FROM provider_offers o JOIN call_attempts c ON c.id = o.call_attempt_id
       WHERE o.request_id = $1 AND o.id = $2 AND c.status = 'offer_received' AND ${latestProviderCall}`,
      [requestId, offerId],
    );
    if (!offer || !offer.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'Offer not found.' } };
    }
    const { rows: [existing] } = await client.query<Booking>(
      `SELECT id, offer_id AS "offerId", backup_offer_id AS "backupOfferId", status FROM bookings
       WHERE request_id = $1 AND status IN ('awaiting_provider_confirmation', 'confirmed')`, [requestId],
    );
    if (existing?.offerId === offerId && existing.backupOfferId === backupOfferId) {
      await client.query('COMMIT');
      return { status: 200, body: { booking: existing } };
    }
    if (existing || !offer.rows[0].available) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: existing ? 'An offer has already been chosen for this request.'
        : 'This visit time has already passed.' } };
    }
    if (backupOfferId) {
      const backup = await client.query(
        `SELECT 1 FROM provider_offers o JOIN call_attempts c ON c.id = o.call_attempt_id
         WHERE o.request_id = $1 AND o.id = $2 AND c.status = 'offer_received' AND ${latestProviderCall}
           AND o.visit_at > clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM bookings WHERE offer_id = o.id)`,
        [requestId, backupOfferId],
      );
      if (!backup.rowCount) {
        await client.query('ROLLBACK');
        return { status: 409, body: { error: 'This backup offer is no longer available.' } };
      }
    }
    const { rows: [booking] } = await client.query<Booking>(
      `INSERT INTO bookings (request_id, offer_id, backup_offer_id) VALUES ($1, $2, $3)
       ON CONFLICT (offer_id) DO NOTHING
       RETURNING id, offer_id AS "offerId", backup_offer_id AS "backupOfferId", status`, [requestId, offerId, backupOfferId],
    );
    if (!booking) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'This offer has already been used.' } };
    }
    await client.query("UPDATE call_attempts SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP WHERE request_id = $1 AND status = 'queued'", [requestId]);
    await client.query('UPDATE service_requests SET collect_offers = false WHERE id = $1', [requestId]);
    await client.query('DELETE FROM request_provider_choices WHERE request_id=$1', [requestId]);
    // Queue the confirmation callback if there is no call currently running.
    await queueBookingConfirmation(client, requestId);
    await client.query('COMMIT');
    return { status: 201, body: { booking } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function endBooking(
  pool: Pool, userId: string, requestId: string, bookingId: string,
  reason: 'cancelled' | 'no_show', findReplacement: boolean,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query('SELECT id FROM service_requests WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [requestId, userId]);
    const booking = owner.rowCount && (await client.query<{
      status: string; replacement_requested: boolean; visit_passed: boolean;
    }>(
      `SELECT b.status, b.replacement_requested, o.visit_at <= clock_timestamp() AS visit_passed
       FROM bookings b JOIN provider_offers o ON o.id = b.offer_id
       WHERE b.id = $1 AND b.request_id = $2`, [bookingId, requestId],
    )).rows[0];
    if (!booking) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'Booking not found.' } };
    }
    const outcome = { status: reason, replacementRequested: findReplacement };
    if (booking.status === reason && booking.replacement_requested === findReplacement) {
      await client.query('COMMIT');
      return { status: 200, body: outcome };
    }
    const active = booking.status === 'confirmed' || booking.status === 'awaiting_provider_confirmation';
    if (!active || (reason === 'no_show' && (booking.status !== 'confirmed' || !booking.visit_passed))) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'This booking cannot be updated that way.' } };
    }
    await client.query(
      `UPDATE bookings SET status = $3, replacement_requested = $4, status_changed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND request_id = $2`, [bookingId, requestId, reason, findReplacement],
    );
    await client.query(
      `UPDATE call_attempts SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP
       WHERE request_id = $1 AND status = 'queued'`, [requestId],
    );
    await client.query('UPDATE service_requests SET collect_offers = $2 WHERE id = $1', [requestId, findReplacement]);
    if (findReplacement) {
      const queued = await queueNextProvider(client, requestId);
      if (!queued.rowCount) {
        const available = await client.query(
          `SELECT 1 FROM request_providers p WHERE p.request_id = $1 AND p.expires_at > clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM call_attempts c WHERE c.request_id = $1 AND c.google_place_id = p.google_place_id
             AND (c.status <> 'cancelled' OR c.started_at IS NOT NULL)) LIMIT 1`, [requestId],
        );
        const alternate = await client.query(
          `SELECT 1 FROM provider_offers o JOIN call_attempts c ON c.id = o.call_attempt_id
           WHERE o.request_id = $1 AND o.visit_at > clock_timestamp() AND c.status = 'offer_received'
             AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.offer_id = o.id) LIMIT 1`, [requestId],
        );
        if (!available.rowCount && !alternate.rowCount) await queueProviderSearch(client, requestId);
      }
    }
    await client.query('COMMIT');
    return { status: 200, body: outcome };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
