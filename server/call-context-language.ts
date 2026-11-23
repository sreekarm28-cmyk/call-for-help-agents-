import type { Pool } from 'pg';
import { verifyServiceAddress } from './providers/geocode-address.js';
import { callLanguage } from './providers/state-language.js';

export async function resolveCallLanguage(pool: Pool, requestId: string, address: string, savedLanguage: string | null) {
  if (savedLanguage) return callLanguage(savedLanguage);
  const verified = await verifyServiceAddress(address);
  const { rows: [request] } = await pool.query<{ preferred_language: string }>(
    `UPDATE service_requests SET preferred_language = COALESCE(preferred_language, $2)
     WHERE id = $1 RETURNING preferred_language`, [requestId, verified.preferredLanguage],
  );
  return callLanguage(request?.preferred_language ?? null);
}
