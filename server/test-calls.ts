import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import type { Pool } from 'pg';
import { resolveCallLanguage } from './call-context-language.js';
import { fetchPlaceDisplay } from './providers/place-display.js';
import { canCallProvider } from './call-limits.js';

export async function testCallSettings() {
  if (process.env.TEST_CALLS_ENABLED !== 'true') return null;
  const local = process.env.TEST_PHONE_NUMBER ? null
    : await readFile(new URL('../LiveKit-Vobiz-Outbound/.env.local', import.meta.url)).catch(() => null);
  const phone = (process.env.TEST_PHONE_NUMBER || (local && parse(local).TEST_PHONE_NUMBER) || '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error('Set TEST_PHONE_NUMBER in E.164 format.');
  return { phone };
}

export async function testCallContext(pool: Pool, id: string) {
  const settings = await testCallSettings();
  if (!settings) return null;
  const { rows: [row] } = await pool.query(
    `SELECT c.id, c.status, c.google_place_id, r.id AS request_id, r.service_type, r.custom_service,
            r.description, r.preferred_date::text, r.preferred_time_window, r.max_visit_fee,
            r.preferred_language, r.service_address AS lookup_address, c.confirmation_booking_id,
            (o.visit_at AT TIME ZONE 'Asia/Kolkata')::date::text AS visit_date,
            to_char(o.visit_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS visit_time,
            o.visit_fee, o.repair_cost_notes, e.fee_covers, e.repair_fee_min, e.repair_fee_max,
            CASE WHEN r.share_name THEN r.contact_name END AS contact_name,
            CASE WHEN r.share_address THEN r.service_address END AS service_address
     FROM call_attempts c JOIN service_requests r ON r.id = c.request_id
     LEFT JOIN bookings b ON b.id = c.confirmation_booking_id AND b.request_id = c.request_id
     LEFT JOIN provider_offers o ON o.id = b.offer_id AND o.request_id = b.request_id
     LEFT JOIN call_attempts original ON original.id = o.call_attempt_id
     LEFT JOIN call_extractions e ON e.call_attempt_id = original.id
     WHERE c.id = $1 AND (c.confirmation_booking_id IS NULL OR
       (b.status = 'awaiting_provider_confirmation' AND b.confirmation_call_attempt_id = c.id
        AND o.visit_at > clock_timestamp()
        AND original.google_place_id = c.google_place_id))`, [id],
  );
  if (!row) return null;
  const language = await resolveCallLanguage(pool, row.request_id, row.lookup_address, row.preferred_language);
  const provider = await fetchPlaceDisplay(row.google_place_id, true).catch(() => null);
  return {
    callAttemptId: row.id, requestId: row.request_id, status: row.status,
    phoneNumber: settings.phone, testCall: true,
    callPurpose: row.confirmation_booking_id ? 'confirmation' : 'collect_offer',
    confirmation: row.confirmation_booking_id ? {
      bookingId: row.confirmation_booking_id, visitDate: row.visit_date, visitTime: row.visit_time,
      visitFee: row.visit_fee, repairCostNotes: row.repair_cost_notes,
      feeCovers: row.fee_covers, repairFeeMin: row.repair_fee_min, repairFeeMax: row.repair_fee_max,
    } : null,
    ...language,
    request: {
      service: row.custom_service ?? row.service_type, description: row.description,
      preferredDate: row.preferred_date, preferredTimeWindow: row.preferred_time_window,
      maxVisitFee: row.max_visit_fee, contactName: row.contact_name, address: row.service_address,
    },
    provider,
  };
}

export async function claimTestCall(pool: Pool, attemptId: string | null = null) {
  if (!await testCallSettings()) return { disabled: true };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_xact_lock(73538142) AS acquired');
    if (!lock.acquired) { await client.query('ROLLBACK'); return null; }
    await client.query(
      `UPDATE call_attempts c SET status = 'cancelled', ended_at = clock_timestamp()
       FROM service_requests r WHERE c.request_id = r.id AND c.status = 'queued'
         AND NOT ${canCallProvider('c.google_place_id')}`,
    );
    const { rows: [call] } = await client.query(
      `WITH next AS (
         SELECT c.id FROM call_attempts c JOIN service_requests r ON r.id = c.request_id
         WHERE c.status = 'queued' AND c.available_at <= clock_timestamp()
           AND ${canCallProvider('c.google_place_id')}
           AND ($1::bigint IS NULL OR c.id = $1)
           AND NOT EXISTS (SELECT 1 FROM call_attempts WHERE status = 'calling')
           AND ((c.confirmation_booking_id IS NULL AND r.collect_offers
             AND EXISTS (SELECT 1 FROM request_providers p
               WHERE p.request_id = c.request_id AND p.google_place_id = c.google_place_id
                 AND p.expires_at > clock_timestamp())
             AND NOT EXISTS (SELECT 1 FROM bookings WHERE request_id = c.request_id
               AND status IN ('awaiting_provider_confirmation', 'confirmed')))
             OR (c.confirmation_booking_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM bookings b JOIN provider_offers o ON o.id = b.offer_id AND o.request_id = b.request_id
               JOIN call_attempts original ON original.id = o.call_attempt_id
               WHERE b.id = c.confirmation_booking_id AND b.request_id = c.request_id
                 AND b.status = 'awaiting_provider_confirmation' AND b.confirmation_call_attempt_id = c.id
                 AND o.visit_at > clock_timestamp()
                 AND original.google_place_id = c.google_place_id)))
         ORDER BY c.id LIMIT 1 FOR UPDATE OF c, r SKIP LOCKED
       ) UPDATE call_attempts c SET status = 'calling', started_at = clock_timestamp()
         FROM next WHERE c.id = next.id RETURNING c.id`, [attemptId],
    );
    await client.query('COMMIT');
    return call ?? null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
