import type { Express } from 'express';
import type { Pool } from 'pg';
import { canHideProviders, validOfferRouteId } from './request-helpers';

export function registerDashboardRoutes(app: Express, pool: Pool) {
  app.get('/api/me/requests', async (request, response) => {
    if (!request.session.userId) {
      response.status(401).json({ error: 'Sign in to view your requests.' });
      return;
    }

    const result = await pool.query(
      `SELECT
         sr.id,
         sr.service_type,
         sr.custom_service,
         sr.description,
         sr.preferred_date,
         sr.preferred_date::text AS "preferredVisitDate",
         (sr.providers_hidden_at IS NOT NULL) AS "providersHidden",
         (sr.current_booking_hidden_at IS NOT NULL) AS "currentBookingHidden",
         (${canHideProviders}) AS "canHideProviders",
         sr.preferred_time_window,
         sr.agent_call_time_window,
         sr.booking_permission,
         sr.max_visit_fee,
         sr.created_at,
         (
           SELECT CASE
             WHEN bool_or(e.extraction_status = 'pending') THEN 'pending'
             WHEN bool_or(c.status = 'calling') THEN 'calling'
             WHEN bool_or(e.extraction_status = 'completed') THEN 'completed'
             WHEN bool_or(e.extraction_status = 'failed') THEN 'failed'
           END
           FROM call_attempts c LEFT JOIN call_extractions e ON e.call_attempt_id = c.id
           WHERE c.request_id = sr.id
         ) AS "callDetailsStatus",
         (EXISTS (SELECT 1 FROM call_attempts c WHERE c.request_id = sr.id AND c.status IN ('queued', 'calling'))
          OR EXISTS (SELECT 1 FROM bookings b JOIN provider_offers o ON o.id = b.offer_id
            LEFT JOIN call_attempts c ON c.id = b.confirmation_call_attempt_id
            WHERE b.request_id = sr.id AND b.status = 'awaiting_provider_confirmation'
              AND o.visit_at > clock_timestamp()
              AND (c.id IS NULL OR c.status IN ('confirmed', 'declined', 'no_answer', 'rejected')))) AS "callWorkRemaining",
         (
           SELECT json_build_object('status', job.status,
             'providerCount', event.metadata->'providerCount',
             'errorCode', event.metadata->>'errorCode')
           FROM scheduled_jobs job
           LEFT JOIN LATERAL (
             SELECT metadata FROM request_events WHERE search_job_id = job.id ORDER BY id DESC LIMIT 1
           ) event ON true
           WHERE job.request_id = sr.id
           ORDER BY job.id DESC LIMIT 1
         ) AS "providerSearch",
         COALESCE((
           SELECT json_agg(json_build_object('id', b.id::text, 'status', b.status,
             'offerId', b.offer_id::text, 'backupOfferId', b.backup_offer_id::text,
             'primaryPlaceId', primary_call.google_place_id, 'backupPlaceId', backup_call.google_place_id,
             'confirmationDecision', confirmation_result.confirmation_decision,
             'confirmationCallStatus', confirmation_call.status,
             'confirmationExtractionStatus', confirmation_result.extraction_status,
             'confirmationAttemptCount', (SELECT count(*) FROM call_attempts h WHERE h.confirmation_booking_id=b.id
               AND (h.status <> 'cancelled' OR h.started_at IS NOT NULL)),
             'confirmationAttemptLimit', CASE b.confirmation_role WHEN 'backup' THEN 2 ELSE 3 END,
             'visitAt', o.visit_at, 'visitFee', o.visit_fee::text) ORDER BY o.visit_at DESC, b.id DESC)
           FROM bookings b JOIN provider_offers o ON o.id = b.offer_id
           JOIN call_attempts primary_call ON primary_call.id = o.call_attempt_id
           LEFT JOIN provider_offers backup ON backup.id = b.backup_offer_id AND backup.request_id = b.request_id
           LEFT JOIN call_attempts backup_call ON backup_call.id = backup.call_attempt_id
           LEFT JOIN call_attempts confirmation_call ON confirmation_call.id=b.confirmation_call_attempt_id
           LEFT JOIN call_extractions confirmation_result ON confirmation_result.call_attempt_id=confirmation_call.id
           WHERE b.request_id = sr.id
         ), '[]'::json) AS bookings,
         (SELECT json_build_object('primaryPlaceId',p.primary_place_id,'backupPlaceId',p.backup_place_id)
           FROM request_provider_choices p WHERE p.request_id=sr.id) AS preferences,
         COALESCE(
           json_agg(
             json_build_object(
               'id', re.id,
               'eventType', re.event_type,
               'status', re.status,
               'actor', re.actor,
               'startedAt', re.started_at,
               'endedAt', re.ended_at,
               'durationMs', re.duration_ms,
               'message', re.message,
               'metadata', re.metadata
             ) ORDER BY re.created_at
           ) FILTER (WHERE re.id IS NOT NULL),
           '[]'::json
         ) AS events
       FROM service_requests sr
       LEFT JOIN request_events re ON re.request_id = sr.id
       WHERE sr.user_id = $1
       GROUP BY sr.id
       ORDER BY sr.created_at DESC
       LIMIT 50`,
      [request.session.userId],
    );

    response.set('Cache-Control', 'no-store').json({ requests: result.rows });
  });

  app.delete('/api/me/requests/:id/:section', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) return response.status(401).json({ error: 'Sign in to update your requests.' });

    const { id, section } = request.params;
    const hiddenColumn = section === 'providers' ? 'providers_hidden_at'
      : section === 'current-booking' ? 'current_booking_hidden_at' : null;
    if (!hiddenColumn || !validOfferRouteId(id)) return response.status(404).json({ error: 'Request not found.' });

    const { rows: [result] } = await pool.query<{ hidden: boolean; owned: boolean }>(
      `WITH hidden AS (
         UPDATE service_requests sr
         SET ${hiddenColumn} = COALESCE(sr.${hiddenColumn}, CURRENT_TIMESTAMP)
         WHERE sr.id = $1 AND sr.user_id = $2
           AND (sr.${hiddenColumn} IS NOT NULL OR (${canHideProviders}))
         RETURNING sr.id
       )
       SELECT EXISTS (SELECT 1 FROM hidden) AS hidden,
              EXISTS (SELECT 1 FROM service_requests WHERE id = $1 AND user_id = $2) AS owned`,
      [id, userId],
    );
    if (result.hidden) return response.status(204).end();
    if (!result.owned) return response.status(404).json({ error: 'Request not found.' });
    return response.status(409).json({ error: 'You can delete this card after the visit date has passed.' });
  });
}
