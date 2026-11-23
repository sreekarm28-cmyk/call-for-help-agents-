import type { Express } from 'express';
import type { Pool } from 'pg';
import { consumeLimit, sendRateLimit } from '../rate-limit';
import { fetchPlaceDisplay } from '../providers/place-display';
import { testCallSettings } from '../test-calls';

export function registerProviderRoutes(app: Express, pool: Pool) {
  app.get('/api/me/requests/:id/provider-search', async (request, response) => {
    if (!request.session.userId) {
      response.status(401).json({ error: 'Sign in to view your request.' });
      return;
    }

    const { id } = request.params;
    if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      response.status(404).json({ error: 'Provider search not found.' });
      return;
    }

    const result = await pool.query(
      `SELECT job.status,
         event.metadata->'providerCount' AS "providerCount",
         event.metadata->'candidateCount' AS "candidateCount",
         event.metadata->'eligibleCount' AS "eligibleCount",
         event.metadata->'strictPassCount' AS "strictPassCount",
         event.metadata->'shortfall' AS "shortfall",
         event.metadata->'ratingFallbackUsed' AS "ratingFallbackUsed",
         event.metadata->'ratingCutoff' AS "ratingCutoff",
         event.metadata->>'errorCode' AS "errorCode"
       FROM scheduled_jobs job
       JOIN service_requests sr ON sr.id = job.request_id
       LEFT JOIN LATERAL (
         SELECT metadata FROM request_events WHERE search_job_id = job.id ORDER BY id DESC LIMIT 1
       ) event ON true
       WHERE sr.id = $1 AND sr.user_id = $2
       ORDER BY job.id DESC LIMIT 1`,
      [id, request.session.userId],
    );

    if (!result.rows[0]) {
      response.status(404).json({ error: 'Provider search not found.' });
      return;
    }
    response.set('Cache-Control', 'no-store').json(result.rows[0]);
  });

  app.get('/api/me/requests/:id/providers', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) {
      response.status(401).json({ error: 'Sign in to view your request.' });
      return;
    }
    const { id } = request.params;
    if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      response.status(404).json({ error: 'Request not found.' });
      return;
    }
    const { rows } = await pool.query<{ place_id: string | null }>(
      `SELECT rp.google_place_id AS place_id
       FROM service_requests sr
       LEFT JOIN request_providers rp ON rp.request_id = sr.id AND rp.expires_at > CURRENT_TIMESTAMP
       WHERE sr.id = $1 AND sr.user_id = $2
       ORDER BY rp.rank`,
      [id, userId],
    );
    if (!rows.length) {
      response.status(404).json({ error: 'Request not found.' });
      return;
    }
    response.set('Cache-Control', 'no-store');
    const placeIds = rows.flatMap(({ place_id }) => place_id ? [place_id] : []);
    if (placeIds.length) {
      const retryAfter = await consumeLimit(pool, 'provider-display-user', userId, 20, 3600);
      if (retryAfter) return sendRateLimit(response, retryAfter);
    }
    const includeContact = request.query.contact === 'true';
    const testSettings = includeContact ? await testCallSettings() : null;
    const details = await Promise.allSettled(placeIds.map((id) => fetchPlaceDisplay(id, includeContact, includeContact && !testSettings)));
    response.json({
      providers: details.map((item) => {
        if (item.status !== 'fulfilled' || !item.value) return null;
        return testSettings ? { ...item.value, phone: testSettings.phone } : item.value;
      }),
    });
  });
}
