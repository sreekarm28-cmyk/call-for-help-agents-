import type { Pool } from 'pg';
import { latestProviderCall } from './provider-recall.js';

export async function saveProviderPreferences(
  pool: Pool, userId: string, requestId: string, primaryCallId: string, backupCallId: string | null,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query('SELECT id FROM service_requests WHERE id=$1 AND user_id=$2 FOR UPDATE', [requestId, userId]);
    const active = owner.rowCount && await client.query(
      "SELECT id FROM bookings WHERE request_id=$1 AND status IN ('awaiting_provider_confirmation','confirmed')", [requestId],
    );
    if (!owner.rowCount || active && active.rowCount) {
      await client.query('ROLLBACK');
      return { status: owner.rowCount ? 409 : 404, body: { error: owner.rowCount
        ? 'Change or cancel your current booking before saving different choices.' : 'Request not found.' } };
    }
    const { rows } = await client.query<{ id: string; google_place_id: string }>(
      `SELECT c.id,c.google_place_id FROM call_attempts c WHERE c.request_id=$1 AND c.id=ANY($2::bigint[])
       AND c.confirmation_booking_id IS NULL AND ${latestProviderCall}`, [requestId, [primaryCallId, backupCallId].filter(Boolean)],
    );
    const primary = rows.find(({ id }) => id === primaryCallId);
    const backup = backupCallId ? rows.find(({ id }) => id === backupCallId) : null;
    if (!primary || backupCallId && !backup || backup?.google_place_id === primary.google_place_id) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'Reload the latest provider cards and choose different vendors.' } };
    }
    const { rows: [preferences] } = await client.query(
      `INSERT INTO request_provider_choices (request_id,primary_place_id,backup_place_id) VALUES ($1,$2,$3)
       ON CONFLICT (request_id) DO UPDATE SET primary_place_id=EXCLUDED.primary_place_id,
         backup_place_id=EXCLUDED.backup_place_id,updated_at=clock_timestamp()
       RETURNING primary_place_id AS "primaryPlaceId",backup_place_id AS "backupPlaceId"`,
      [requestId, primary.google_place_id, backup?.google_place_id ?? null],
    );
    // A saved preference authorizes no phone call. Call again remains an explicit user action.
    await client.query(
      `UPDATE call_attempts SET status='cancelled',ended_at=clock_timestamp()
       WHERE request_id=$1 AND confirmation_booking_id IS NULL AND status='queued'
         AND google_place_id <> ALL($2::text[])`,
      [requestId, [primary.google_place_id, backup?.google_place_id].filter(Boolean)],
    );
    await client.query('UPDATE service_requests SET collect_offers=true WHERE id=$1', [requestId]);
    await client.query('COMMIT');
    return { status: 200, body: { preferences } };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
