import type { Express } from 'express';
import type { Pool } from 'pg';
import { observe } from '../observability';
import { consumeLimit, sendRateLimit } from '../rate-limit';
import { verifyServiceAddress, UnresolvedAddressError, type VerifiedServiceAddress } from '../providers/geocode-address';
import { validateServiceRequest, type ServiceRequestInput, type ValidServiceRequest } from '../requests/validation';

export function registerRequestRoutes(app: Express, pool: Pool) {
  app.post('/api/service-requests', async (request, response) => {
    if (!request.session.userId) {
      response.status(401).json({ error: 'Sign in to save a request.' });
      return;
    }

    const userId = request.session.userId;
    const submissionId = request.get('Idempotency-Key') ?? null;
    if (submissionId !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(submissionId)) {
      response.status(400).json({ error: 'Invalid submission ID.' });
      return;
    }
    if (submissionId !== null) {
      const { rows: [existing] } = await pool.query<{ id: string; created_at: Date }>(
        'SELECT id, created_at FROM service_requests WHERE user_id = $1 AND submission_id = $2',
        [userId, submissionId],
      );
      if (existing) {
        response.status(200).json({ requestId: Number(existing.id), createdAt: existing.created_at });
        return;
      }
    }
    let input: ValidServiceRequest;
    const requestStartedAt = new Date();
    let validationEndedAt: Date;
    let verifiedLocation: VerifiedServiceAddress;

    try {
      input = await observe(
        'Validate service request',
        {},
        async () => validateServiceRequest((request.body ?? {}) as ServiceRequestInput),
      );
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request.' });
      return;
    }

    const lookupRetryAfter = await consumeLimit(pool, 'service-address-user', userId, 30, 3600);
    if (lookupRetryAfter) return sendRateLimit(response, lookupRetryAfter);

    const addressCheck = observe('Verify service address', {}, () => verifyServiceAddress(input.serviceAddress))
      .then((location) => ({ ok: true, location }) as const,
        (error: unknown) => ({ ok: false, error }) as const);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const requestResult = await observe(
        'Save service request',
        {
          serviceType: input.serviceType,
          bookingPermission: input.bookingPermission,
        },
        async () => client.query<{ id: string; created_at: Date }>(
          `INSERT INTO service_requests (
             user_id, service_type, custom_service, description,
             contact_name, contact_phone, service_address,
             preferred_date, preferred_time_window, agent_call_time_window,
             max_visit_fee, share_name, share_phone, share_address,
             booking_permission, submission_id, collect_offers, latitude, longitude
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, true, $17, $18
           )
           ON CONFLICT (user_id, submission_id) DO NOTHING
           RETURNING id, created_at`,
          [
            userId,
            input.serviceType,
            input.customService,
            input.description,
            input.contactName,
            input.contactPhone,
            input.serviceAddress,
            input.preferredDate,
            input.preferredTimeWindow,
            input.agentCallTimeWindow,
            input.maxVisitFee,
            input.shareName,
            input.sharePhone,
            input.shareAddress,
            input.bookingPermission,
            submissionId,
            null,
            null,
          ],
        ),
      );

      const saved = requestResult.rows[0];
      if (!saved) {
        const { rows: [existing] } = await client.query<{ id: string; created_at: Date }>(
          'SELECT id, created_at FROM service_requests WHERE user_id = $1 AND submission_id = $2',
          [userId, submissionId],
        );
        await client.query('COMMIT');
        response.status(200).json({ requestId: Number(existing.id), createdAt: existing.created_at });
        return;
      }

      const retryAfter = await consumeLimit(client, 'service-request-user', userId, 20, 3600);
      if (retryAfter) {
        await client.query('ROLLBACK');
        sendRateLimit(response, retryAfter);
        return;
      }
      const requestId = saved.id;

      await client.query(
        `INSERT INTO scheduled_jobs (request_id, run_at, message)
         VALUES ($1, CURRENT_TIMESTAMP, 'Search for service providers')`,
        [requestId],
      );

      const verification = await addressCheck;
      if (!verification.ok) {
        await client.query('ROLLBACK');
        if (verification.error instanceof UnresolvedAddressError) {
          response.status(422).json({ error: verification.error.message, errorCode: 'address_unresolved' });
        } else {
          console.error('service_address_verification_unavailable');
          response.status(503).json({ error: 'We could not verify the address right now. Please try again.' });
        }
        return;
      }
      verifiedLocation = verification.location;
      validationEndedAt = new Date();
      await client.query('UPDATE service_requests SET latitude = $2, longitude = $3, preferred_language = $4 WHERE id = $1',
        [requestId, verifiedLocation.latitude, verifiedLocation.longitude, verifiedLocation.preferredLanguage]);
      const savedAt = new Date();

      await client.query(
        `INSERT INTO request_events (
           request_id, event_type, status, actor, started_at, ended_at,
           duration_ms, message, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          requestId,
          'request_received',
          'completed',
          'system',
          requestStartedAt,
          validationEndedAt,
          validationEndedAt.getTime() - requestStartedAt.getTime(),
          'Request validated and accepted.',
          { serviceType: input.serviceType },
        ],
      );

      await client.query(
        `INSERT INTO request_events (
           request_id, event_type, status, actor, started_at, ended_at,
           duration_ms, message, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          requestId,
          'request_saved',
          'completed',
          'system',
          validationEndedAt,
          savedAt,
          savedAt.getTime() - validationEndedAt.getTime(),
          'Request saved to PostgreSQL.',
          { bookingPermission: input.bookingPermission },
        ],
      );

      if (input.rememberDetails) {
        await client.query(
          `UPDATE users
           SET contact_name = $1, contact_phone = $2, service_address = $3
           WHERE id = $4`,
          [input.contactName, input.contactPhone, input.serviceAddress, request.session.userId],
        );
      }

      await client.query('COMMIT');
      response.status(201).json({
        requestId: Number(requestId),
        createdAt: saved.created_at,
      });
    } catch {
      await client.query('ROLLBACK');
      console.error('service_request_save_failed');
      response.status(500).json({ error: 'Could not save your request. Please try again.' });
    } finally {
      client.release();
    }
  });
}
