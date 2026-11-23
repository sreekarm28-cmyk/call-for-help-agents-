import type { PoolClient } from 'pg';
import { canCallProvider } from '../call-limits.js';
import { advanceBookingConfirmation } from '../bookings/booking-confirmation.js';

export const requestedShortlistDeadline = `
  (r.preferred_date + CASE r.preferred_time_window
    WHEN 'morning' THEN time '12:00' WHEN 'afternoon' THEN time '16:00'
    WHEN 'evening' THEN time '20:00' ELSE time '24:00' END)
  AT TIME ZONE 'Asia/Kolkata' + interval '10 hours'`;

// Caller holds the service request row lock.
export async function queueNextProvider(client: PoolClient, requestId: string) {
  return client.query(
    `INSERT INTO call_attempts (request_id, google_place_id)
     SELECT p.request_id, p.google_place_id
     FROM request_providers p
     JOIN service_requests r ON r.id = p.request_id
     WHERE p.request_id = $1 AND r.collect_offers
       AND NOT EXISTS (SELECT 1 FROM request_provider_choices WHERE request_id=r.id)
       AND ${canCallProvider('p.google_place_id')}
       AND p.expires_at > clock_timestamp()
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = $1
         AND b.status IN ('awaiting_provider_confirmation', 'confirmed'))
       AND NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.request_id = $1 AND j.status IN ('pending', 'running'))
       AND NOT EXISTS (SELECT 1 FROM call_attempts c WHERE c.request_id = $1
         AND (c.status IN ('queued', 'calling') OR
              (c.google_place_id = p.google_place_id AND (c.status <> 'cancelled' OR c.started_at IS NOT NULL))))
     ORDER BY p.rank LIMIT 1
     RETURNING id`,
    [requestId],
  );
}

export async function queueProviderSearch(client: PoolClient, requestId: string) {
  await client.query(
    `INSERT INTO scheduled_jobs (request_id, run_at, message)
     VALUES ($1, CURRENT_TIMESTAMP, 'Search for replacement providers')
     ON CONFLICT (request_id) WHERE status IN ('pending', 'running') DO NOTHING`,
    [requestId],
  );
}

export async function advanceOutreach(client: PoolClient, requestId: string) {
  await advanceBookingConfirmation(client, requestId);
  await queueNextProvider(client, requestId);
}
