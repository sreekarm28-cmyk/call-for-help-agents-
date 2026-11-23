import assert from 'node:assert/strict';
import { waitFor, type FlowContext } from './flow-helpers.js';

export async function testBookingFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, requests } = context;
  const requestId = requests[0].requestId;
  const offersPath = baseUrl + `/api/me/requests/${requestId}/offers`;
  const emptyOffers = await fetch(offersPath, { headers: { cookie }, signal: AbortSignal.timeout(5_000) });
  assert.equal(emptyOffers.status, 200);
  assert.deepEqual(await emptyOffers.json(), {
    offers: [], progress: { shortlisted: 5, attempted: 0, inProgress: true },
  });
  const { rows: offers } = await database.query<{ id: string }>(
    `WITH first_call AS (
       UPDATE "${schema}".call_attempts SET status = 'offer_received', summary = 'First sample quote.',
         transcript = 'Provider: The visit fee is 300 rupees.'
       WHERE request_id = $1 AND google_place_id = 'test-place-1'
       RETURNING id, request_id
     ), second_call AS (
       INSERT INTO "${schema}".call_attempts (request_id, google_place_id, status, summary)
       VALUES ($1, 'test-place-2', 'offer_received', 'Second sample quote.')
       RETURNING id, request_id
     )
     INSERT INTO "${schema}".provider_offers (request_id, call_attempt_id, visit_at, visit_fee)
     SELECT request_id, id, CURRENT_TIMESTAMP + INTERVAL '1 day', 300
     FROM (SELECT * FROM first_call UNION ALL SELECT * FROM second_call) calls
     RETURNING id`, [requestId],
  );
  await database.query(
    `INSERT INTO "${schema}".call_attempts (request_id, google_place_id) VALUES ($1, 'test-place-3')
     ON CONFLICT DO NOTHING`,
    [requestId],
  );
  const comparison = await fetch(offersPath + '?details=true', { headers: { cookie }, signal: AbortSignal.timeout(8_000) });
  assert.equal(comparison.status, 200);
  const displayed = await comparison.json() as { offers: { provider: { rating: number }; transcript: string | null }[] };
  assert.equal(displayed.offers.length, 2);
  assert.equal(displayed.offers[0].provider.rating, 4.5);
  assert.ok(displayed.offers.some(({ transcript }) => transcript === 'Provider: The visit fee is 300 rupees.'));
  const choose = (offerId: string) => fetch(`${offersPath}/${offerId}/select`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupOfferId: offers.find(({ id }) => id !== offerId)?.id }),
    signal: AbortSignal.timeout(5_000),
  });
  const selections = await Promise.all(offers.map(({ id }) => choose(id)));
  assert.deepEqual(selections.map(({ status }) => status).sort(), [201, 409]);
  const selection = await selections.find(({ status }) => status === 201)!.json() as {
    booking: { id: string; offerId: string; backupOfferId: string; status: string };
  };
  assert.equal(selection.booking.status, 'awaiting_provider_confirmation');
  assert.equal(selection.booking.backupOfferId, offers.find(({ id }) => id !== selection.booking.offerId)?.id);
  const replay = await choose(selection.booking.offerId);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), selection);
  const { rows: [queued] } = await database.query(
    `SELECT status FROM "${schema}".call_attempts WHERE request_id = $1 AND google_place_id = 'test-place-3'`,
    [requestId],
  );
  assert.equal(queued.status, 'cancelled');
  const bookingId = selection.booking.id;
  await database.query(
    `UPDATE "${schema}".call_attempts SET status = 'confirmed'
     WHERE confirmation_booking_id = $1`, [bookingId],
  );
  await waitFor('booking confirmation', async () => {
    const { rows: [booking] } = await database.query(
      `SELECT status FROM "${schema}".bookings WHERE id = $1`, [bookingId],
    );
    return booking.status === 'confirmed' ? true : undefined;
  });
  const { rows: [deadline] } = await database.query(
    `SELECT bool_and(p.expires_at = o.visit_at + interval '10 hours') AS correct
     FROM "${schema}".request_providers p JOIN "${schema}".provider_offers o ON o.request_id = p.request_id
     WHERE p.request_id = $1 AND o.id = $2`, [requestId, selection.booking.offerId],
  );
  assert.equal(deadline.correct, true);
  context.bookingId = bookingId;
  console.log('PASS compares offers, accepts one selection, and stops the queued call.');
}
