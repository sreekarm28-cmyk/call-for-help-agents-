import { createHash } from 'node:crypto';
import type { Response } from 'express';
import type { Pool, PoolClient } from 'pg';

export async function consumeLimit(
  database: Pool | PoolClient,
  scope: string,
  identifier: string,
  maximum: number,
  windowSeconds: number,
) {
  const key = scope + ':' + createHash('sha256').update(identifier).digest('hex');
  const { rows: [bucket] } = await database.query<{ count: number; retry_after: number }>(
    `INSERT INTO request_rate_limits (key, count, expires_at)
     VALUES ($1, 1, statement_timestamp() + $2 * INTERVAL '1 second')
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN request_rate_limits.expires_at <= statement_timestamp()
                    THEN 1 ELSE LEAST(request_rate_limits.count + 1, $3 + 1) END,
       expires_at = CASE WHEN request_rate_limits.expires_at <= statement_timestamp()
                         THEN EXCLUDED.expires_at ELSE request_rate_limits.expires_at END
     RETURNING count, CEIL(EXTRACT(EPOCH FROM expires_at - statement_timestamp()))::integer AS retry_after`,
    [key, windowSeconds, maximum],
  );
  return bucket.count > maximum ? bucket.retry_after : 0;
}

export function sendRateLimit(response: Response, retryAfter: number) {
  response.set('Retry-After', String(retryAfter));
  response.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
}
