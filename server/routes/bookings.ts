import type { Express } from 'express';
import type { Pool } from 'pg';
import { consumeLimit, sendRateLimit } from '../rate-limit';
import { fetchPlaceDisplay } from '../providers/place-display';
import { endBooking, listOffers, selectOffer } from '../provider-offers';
import { retryBookingConfirmation } from '../confirmation-retry';
import { recallProvider } from '../provider-recall';
import { saveProviderPreferences } from '../provider-preferences';
import { validOfferRouteId } from './request-helpers';

export function registerBookingRoutes(app: Express, pool: Pool) {
  app.get('/api/me/requests/:id/booking-choices', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) return response.sendStatus(401);
    const { id } = request.params;
    if (!validOfferRouteId(id)) return response.sendStatus(404);
    const { rows: [booking] } = await pool.query<{
      id: string; offer_id: string | null; backup_offer_id: string | null; primary_place_id: string; backup_place_id: string | null;
    }>(
      `SELECT COALESCE(b.id::text,'preferences-'||r.id) AS id,b.offer_id,b.backup_offer_id,
              COALESCE(primary_call.google_place_id,p.primary_place_id) AS primary_place_id,
              CASE WHEN b.id IS NOT NULL THEN backup_call.google_place_id ELSE p.backup_place_id END AS backup_place_id
       FROM service_requests r
       LEFT JOIN bookings b ON b.request_id=r.id AND b.status IN ('awaiting_provider_confirmation','confirmed')
       LEFT JOIN request_provider_choices p ON p.request_id=r.id
       LEFT JOIN provider_offers o ON o.id = b.offer_id
       LEFT JOIN call_attempts primary_call ON primary_call.id = o.call_attempt_id
       LEFT JOIN provider_offers backup ON backup.id = b.backup_offer_id AND backup.request_id = b.request_id
       LEFT JOIN call_attempts backup_call ON backup_call.id = backup.call_attempt_id
       WHERE r.id = $1 AND r.user_id = $2 AND (b.id IS NOT NULL OR p.request_id IS NOT NULL)`, [id, userId],
    );
    if (!booking) return response.sendStatus(404);
    const retryAfter = await consumeLimit(pool, 'booking-choice-display-user', userId, 60, 3600);
    if (retryAfter) return sendRateLimit(response, retryAfter);
    const display = async (placeId: string, offerId: string | null) => ({
      placeId, offerId, ...await fetchPlaceDisplay(placeId).catch(() => null),
    });
    const [primary, backup] = await Promise.all([
      display(booking.primary_place_id, booking.offer_id),
      booking.backup_place_id ? display(booking.backup_place_id, booking.backup_offer_id) : null,
    ]);
    return response.set('Cache-Control', 'no-store').json({ bookingId: booking.id, primary, backup });
  });

  app.get('/api/me/requests/:id/offers', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) {
      response.status(401).json({ error: 'Sign in to see provider offers.' });
      return;
    }
    const { id } = request.params;
    if (!validOfferRouteId(id) || !(await pool.query(
      'SELECT 1 FROM service_requests WHERE id = $1 AND user_id = $2', [id, userId],
    )).rowCount) {
      response.status(404).json({ error: 'Request not found.' });
      return;
    }
    const includeDetails = request.query.details === 'true';
    if (includeDetails) {
      const retryAfter = await consumeLimit(pool, 'offer-display-user', userId, 20, 3600);
      if (retryAfter) return sendRateLimit(response, retryAfter);
    }
    const includeTranscript = includeDetails || request.query.transcripts === 'true';
    response.set('Cache-Control', 'no-store').json(await listOffers(pool, id, includeDetails, includeTranscript));
  });

  app.post('/api/me/requests/:id/provider-choices', async (request, response) => {
    const userId=request.session.userId;
    if (!userId) return response.sendStatus(401);
    const { id }=request.params;
    const { primaryCallId, backupCallId }=request.body ?? {};
    if (!validOfferRouteId(id)) return response.sendStatus(404);
    if (typeof primaryCallId !== 'string' || !validOfferRouteId(primaryCallId) ||
        (backupCallId != null && (typeof backupCallId !== 'string' || !validOfferRouteId(backupCallId) || backupCallId === primaryCallId))) {
      return response.status(400).json({ error: 'Choose different providers for first choice and backup.' });
    }
    const result=await saveProviderPreferences(pool,userId,id,primaryCallId,backupCallId ?? null);
    return response.status(result.status).json(result.body);
  });

  app.post('/api/me/requests/:id/calls/:callId/recall', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) return response.status(401).json({ error: 'Sign in to call a provider again.' });
    const { id, callId } = request.params;
    if (!validOfferRouteId(id) || !validOfferRouteId(callId)) return response.sendStatus(404);
    const result = await recallProvider(pool, userId, id, callId);
    return response.status(result.status).json(result.body);
  });

  app.post('/api/me/requests/:id/offers/:offerId/select', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) {
      response.status(401).json({ error: 'Sign in to choose an offer.' });
      return;
    }
    const { id, offerId } = request.params;
    if (!validOfferRouteId(id) || !validOfferRouteId(offerId)) {
      response.status(404).json({ error: 'Offer not found.' });
      return;
    }
    const backupOfferId: unknown = request.body?.backupOfferId;
    if (backupOfferId != null && (typeof backupOfferId !== 'string' || !validOfferRouteId(backupOfferId) || backupOfferId === offerId)) {
      return response.status(400).json({ error: 'Choose a different offer as your backup.' });
    }
    const result = await selectOffer(pool, userId, id, offerId, backupOfferId ?? null);
    response.status(result.status).json(result.body);
  });

  app.post('/api/me/requests/:id/bookings/:bookingId/retry-confirmation', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) return response.status(401).json({ error: 'Sign in to retry confirmation.' });
    const { id, bookingId } = request.params;
    const previousAttemptId: unknown = request.body?.callAttemptId;
    if (!validOfferRouteId(id) || !validOfferRouteId(bookingId)) return response.sendStatus(404);
    if (typeof previousAttemptId !== 'string' || !validOfferRouteId(previousAttemptId)) {
      return response.status(400).json({ error: 'Reload the booking before retrying confirmation.' });
    }
    const result = await retryBookingConfirmation(pool, userId, id, bookingId, previousAttemptId);
    return response.status(result.status).json(result.body);
  });

  app.post('/api/me/requests/:id/bookings/:bookingId/end', async (request, response) => {
    const userId = request.session.userId;
    if (!userId) {
      response.status(401).json({ error: 'Sign in to update a booking.' });
      return;
    }
    const { id, bookingId } = request.params;
    if (!validOfferRouteId(id) || !validOfferRouteId(bookingId)) {
      response.status(404).json({ error: 'Booking not found.' });
      return;
    }
    const { reason, findReplacement } = request.body ?? {};
    if ((reason !== 'cancelled' && reason !== 'no_show') || typeof findReplacement !== 'boolean') {
      response.status(400).json({ error: 'Choose a reason and whether you want a replacement.' });
      return;
    }
    const result = await endBooking(pool, userId, id, bookingId, reason, findReplacement);
    response.status(result.status).json(result.body);
  });
}
