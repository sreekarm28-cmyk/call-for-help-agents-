import type { Pool } from 'pg';
import { canCallProvider } from './call-limits.js';

export const latestProviderCall = `NOT EXISTS (SELECT 1 FROM call_attempts newer
  WHERE newer.request_id = c.request_id AND newer.google_place_id = c.google_place_id
    AND newer.confirmation_booking_id IS NULL AND newer.id > c.id
    AND (newer.status <> 'cancelled' OR newer.started_at IS NOT NULL))`;

// Queries using this expression join request r, call c, extraction e, shortlist p.
export const recallBlockedReason = `CASE
  WHEN EXISTS (SELECT 1 FROM bookings WHERE request_id = r.id
    AND status IN ('awaiting_provider_confirmation', 'confirmed')) THEN 'A booking is already selected.'
  WHEN NOT r.collect_offers THEN 'This request is no longer collecting offers.'
  WHEN p.expires_at IS NULL OR p.expires_at <= clock_timestamp() THEN 'Search again to refresh this provider.'
  WHEN c.status IN ('queued', 'calling') THEN 'This provider already has a call queued or in progress.'
  WHEN e.extraction_status = 'pending' THEN 'Wait for the call review to finish.'
  WHEN EXISTS (SELECT 1 FROM call_attempts WHERE request_id = r.id AND status IN ('queued', 'calling'))
    THEN 'Wait for the current provider call to finish.'
  WHEN NOT ${canCallProvider('c.google_place_id')} THEN 'The account limit for new vendors has been reached.'
  ELSE NULL END`;

export async function recallProvider(pool: Pool, userId: string, requestId: string, callId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query('SELECT id FROM service_requests WHERE id = $1 AND user_id = $2 FOR UPDATE', [requestId, userId]);
    const { rows: [call] } = owner.rowCount ? await client.query<{
      google_place_id: string; latest_id: string; blocked: string | null;
    }>(
      `SELECT c.google_place_id, ${recallBlockedReason} AS blocked,
              (SELECT id FROM call_attempts newer WHERE newer.request_id = c.request_id
               AND newer.google_place_id = c.google_place_id AND newer.confirmation_booking_id IS NULL
               AND (newer.status <> 'cancelled' OR newer.started_at IS NOT NULL) ORDER BY id DESC LIMIT 1) AS latest_id
       FROM call_attempts c JOIN service_requests r ON r.id = c.request_id
       LEFT JOIN call_extractions e ON e.call_attempt_id = c.id
       LEFT JOIN request_providers p ON p.request_id = c.request_id AND p.google_place_id = c.google_place_id
       WHERE c.id = $1 AND c.request_id = $2 AND c.confirmation_booking_id IS NULL`, [callId, requestId],
    ) : { rows: [] };
    let result: { status: number; body: { error?: string; callAttemptId?: string } };
    if (!call) result = { status: 404, body: { error: 'Provider call not found.' } };
    else if (call.latest_id && call.latest_id !== callId) result = { status: 200, body: { callAttemptId: call.latest_id } };
    else if (call.blocked) result = { status: 409, body: { error: call.blocked } };
    else {
      const { rows: [next] } = await client.query<{ id: string }>(
        'INSERT INTO call_attempts (request_id, google_place_id) VALUES ($1, $2) RETURNING id', [requestId, call.google_place_id],
      );
      result = { status: 201, body: { callAttemptId: next.id } };
    }
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
