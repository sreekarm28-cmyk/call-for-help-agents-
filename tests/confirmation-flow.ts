import assert from 'node:assert/strict';
import { waitFor, type FlowContext } from './flow-helpers.js';
import { testConfirmationRetryFlow } from './confirmation-retry-flow.js';
import { testConfirmationPolicyFlow } from './confirmation-policy-flow.js';

export async function testConfirmationFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, env, post } = context;
  const table = (name: string) => `"${schema}".${name}`;
  const headers = { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' };
  const internal = (path: string, body: object) => fetch(baseUrl + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  context.startWorker();

  async function setup() {
    // Seed previously collected offers; selection and all later steps use the API/worker.
    await database.query('BEGIN');
    try {
      const { rows: [request] } = await database.query<{ id: string }>(
        `INSERT INTO ${table('service_requests')} (user_id, service_type, description, contact_name,
          contact_phone, service_address, preferred_date, preferred_time_window, preferred_language)
         SELECT id, 'plumber', 'Leaking tap', 'Tester', '+919999900001', 'Strict test address',
                CURRENT_DATE + 2, 'morning', 'te' FROM ${table('users')}
         WHERE email = 'provider-flow@example.test' RETURNING id`,
      );
      const offers: string[] = [];
      for (const [rank, fee] of [[1, 300], [2, 400]]) {
        const { rows: [call] } = await database.query<{ id: string }>(
          `INSERT INTO ${table('call_attempts')} (request_id, google_place_id, status, started_at, ended_at)
           VALUES ($1, $2, 'offer_received', clock_timestamp(), clock_timestamp()) RETURNING id`,
          [request.id, `test-place-${rank}`],
        );
        await database.query(
          `INSERT INTO ${table('request_providers')} (request_id, google_place_id, rank, expires_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP + interval '3 days')`,
          [request.id, `test-place-${rank}`, rank],
        );
        const { rows: [offer] } = await database.query<{ id: string }>(
          `INSERT INTO ${table('provider_offers')} (request_id, call_attempt_id, visit_at, visit_fee, repair_cost_notes)
           VALUES ($1, $2, (CURRENT_DATE + 2 + time '10:00') AT TIME ZONE 'Asia/Kolkata', $3,
                   'Repair decided on site; parts extra.') RETURNING id`, [request.id, call.id, fee],
        );
        offers.push(offer.id);
      }
      await database.query('COMMIT');
      const selected = await post(`/api/me/requests/${request.id}/offers/${offers[0]}/select`,
        { backupOfferId: offers[1] }, cookie);
      assert.equal(selected.status, 201);
      const { booking } = await selected.json();
      const { rows: [call] } = await database.query<{ id: string; google_place_id: string }>(
        `SELECT id, google_place_id FROM ${table('call_attempts')} WHERE confirmation_booking_id = $1`, [booking.id],
      );
      assert.equal(call.google_place_id, 'test-place-1');
      assert.equal((await database.query(
        `SELECT id FROM ${table('call_attempts')} WHERE request_id = $1 AND confirmation_booking_id IS NOT NULL`, [request.id],
      )).rowCount, 1, 'Only the primary may be queued after selection.');
      return { requestId: request.id, bookingId: booking.id as string, callId: call.id, offers };
    } catch (error) { await database.query('ROLLBACK'); throw error; }
  }
  const status = async (id: string) => (await database.query<{ status: string }>(
    `SELECT status FROM ${table('bookings')} WHERE id = $1`, [id],
  )).rows[0].status;
  const backupCalls = async (requestId: string) => (await database.query(
    `SELECT c.id, c.status FROM ${table('call_attempts')} c WHERE c.request_id = $1
     AND c.confirmation_booking_id IS NOT NULL AND c.google_place_id = 'test-place-2'`, [requestId],
  )).rows;
  const claim = async (id: string) => {
    const claimed = await internal('/api/internal/test-calls/claim', { callAttemptId: id });
    assert.equal(claimed.status, 200);
  };
  const transcript = async (callId: string, text: string) => {
    const path = `/api/internal/call-attempts/${callId}/transcript`;
    assert.equal((await internal(path, { transcript: text })).status, 201);
    assert.equal((await internal(path, { transcript: text })).status, 200);
    return waitFor('confirmation transcript decision', async () => {
      const { rows: [row] } = await database.query<{ extraction_status: string; confirmation_decision: string }>(
        `SELECT extraction_status, confirmation_decision FROM ${table('call_extractions')} WHERE call_attempt_id = $1`, [callId],
      );
      assert.notEqual(row?.extraction_status, 'failed');
      return row?.extraction_status === 'completed' ? row.confirmation_decision : undefined;
    });
  };
  const acceptance = 'Agent: Do you accept this booking at the agreed date, time and fees?\nYou: I accept those terms.';

  const accepted = await setup();
  const claims = await Promise.all([1, 2].map(() => internal('/api/internal/test-calls/claim', { callAttemptId: accepted.callId })));
  assert.deepEqual(claims.map(({ status }) => status).sort(), [200, 204]);
  const callContext = await fetch(baseUrl + `/api/internal/call-attempts/${accepted.callId}/context`, { headers });
  assert.equal(callContext.status, 200);
  const details = await callContext.json();
  assert.equal(details.callPurpose, 'confirmation');
  assert.equal(details.phoneNumber, env.TEST_PHONE_NUMBER);
  assert.equal(details.confirmation.visitFee, '300.00');
  assert.equal(details.confirmation.visitTime, '10:00');
  const pendingDashboard = await fetch(baseUrl + '/api/me/requests', { headers: { cookie } });
  assert.equal((await pendingDashboard.json()).requests.find((r: { id: string | number }) =>
    String(r.id) === accepted.requestId).callWorkRemaining, true);
  assert.equal(await transcript(accepted.callId, acceptance), 'confirmed');
  assert.equal(await status(accepted.bookingId), 'confirmed');
  assert.deepEqual(await backupCalls(accepted.requestId), []);
  const displayed = await fetch(baseUrl + `/api/me/requests/${accepted.requestId}/offers?details=true`, { headers: { cookie } });
  const screen = await displayed.json();
  assert.equal(screen.booking.status, 'confirmed');
  assert.equal(screen.offers.length, 2, 'A confirmation must not create another offer card.');
  const choicesPath = baseUrl + `/api/me/requests/${accepted.requestId}/booking-choices`;
  assert.equal((await fetch(choicesPath)).status, 401);
  const choicesResponse = await fetch(choicesPath, { headers: { cookie } });
  assert.equal(choicesResponse.status, 200);
  const choices = await choicesResponse.json();
  assert.equal(choices.primary.offerId, accepted.offers[0]);
  assert.equal(choices.primary.name, 'Test Plumber 1');
  assert.equal(choices.backup.offerId, accepted.offers[1]);
  assert.equal(choices.backup.name, 'Test Plumber 2');
  assert.equal('phone' in choices.primary, false);
  const dashboard = await fetch(baseUrl + '/api/me/requests', { headers: { cookie } });
  const card = (await dashboard.json()).requests.find((r: { id: string | number }) => String(r.id) === accepted.requestId);
  const cardBooking = card.bookings.find((b: { id: string }) => b.id === accepted.bookingId);
  assert.equal(cardBooking.primaryPlaceId, choices.primary.placeId);
  assert.equal(cardBooking.backupPlaceId, choices.backup.placeId);
  console.log('PASS the dashboard exposes saved first/backup choices and loads their names without phone numbers.');
  console.log('PASS primary acceptance confirms the UI booking; no backup call or duplicate offer is created.');

  for (const reply of ['You: Maybe, call me later.', 'You: I accept those terms. changed fee',
    'You: I accept those terms. changed time', 'You: Unsupported acceptance',
    'You: Yes, this is my number.', 'You: I accept those terms. missing final question',
    'You: I accept those terms.\nAgent: Do you confirm the booking, yes or no?']) {
    const unclear = await setup();
    await claim(unclear.callId);
    assert.equal(await transcript(unclear.callId, 'Agent: Please confirm the agreed terms.\n' + reply), 'needs_clarification');
    assert.equal(await status(unclear.bookingId), 'awaiting_provider_confirmation');
    assert.deepEqual(await backupCalls(unclear.requestId), []);
  }
  console.log('PASS uncertainty, changed fees/times, and unsupported model evidence stay pending without calling backup.');

  const failed = await setup();
  await claim(failed.callId);
  assert.equal((await internal(`/api/internal/call-attempts/${failed.callId}/outcome`, { status: 'failed' })).status, 200);
  assert.equal(await status(failed.bookingId), 'awaiting_provider_confirmation');
  assert.deepEqual(await backupCalls(failed.requestId), []);
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: failed.callId })).status, 204);
  console.log('PASS a technical failure stays pending and cannot start a backup or duplicate the original call.');

  for (const noAnswer of [false, true]) {
    const rejected = await setup();
    await claim(rejected.callId);
    if (noAnswer) {
      let currentId = rejected.callId;
      for (let attempt = 1; attempt <= 3; attempt++) {
        assert.equal((await internal(`/api/internal/call-attempts/${currentId}/outcome`, { status: 'no_answer' })).status, 200);
        if (attempt < 3) {
          const nextId = await waitFor('next primary attempt', async () => {
            const { rows: [b] } = await database.query<{ confirmation_call_attempt_id: string }>(
              `SELECT confirmation_call_attempt_id FROM ${table('bookings')} WHERE id = $1`, [rejected.bookingId],
            );
            return b.confirmation_call_attempt_id !== currentId ? b.confirmation_call_attempt_id : undefined;
          });
          assert.deepEqual(await backupCalls(rejected.requestId), []);
          assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: nextId })).status, 204);
          await database.query(`UPDATE ${table('call_attempts')} SET available_at = clock_timestamp() WHERE id = $1`, [nextId]);
          await claim(nextId);
          currentId = nextId;
        }
      }
    } else {
      assert.equal(await transcript(rejected.callId,
        'Agent: Do you accept the agreed terms?\nYou: I accept those terms.\n' +
        'Agent: Do you confirm the booking, yes or no?\nYou: No, do not book it.'), 'declined');
    }
    const backup = await waitFor('only the selected backup to be queued', async () => (await backupCalls(rejected.requestId))[0]);
    assert.equal(await status(rejected.bookingId), 'cancelled');
    assert.equal(backup.status, 'queued');
    const { rows: [next] } = await database.query(
      `SELECT offer_id FROM ${table('bookings')} WHERE request_id = $1 AND status = 'awaiting_provider_confirmation'`, [rejected.requestId],
    );
    assert.equal(next.offer_id, rejected.offers[1]);
    await claim(backup.id);
    assert.equal(await transcript(backup.id, acceptance), 'confirmed');
    assert.equal((await backupCalls(rejected.requestId)).length, 1);
    const promoted = await fetch(baseUrl + `/api/me/requests/${rejected.requestId}/booking-choices`, { headers: { cookie } });
    const promotedChoices = await promoted.json();
    assert.equal(promotedChoices.primary.offerId, rejected.offers[1]);
    assert.equal(promotedChoices.backup, null);
  }
  console.log('PASS refusal or no answer promotes only the selected backup and confirms it through its own call.');

  const cancelled = await setup();
  await claim(cancelled.callId);
  const ended = await post(`/api/me/requests/${cancelled.requestId}/bookings/${cancelled.bookingId}/end`,
    { reason: 'cancelled', findReplacement: false }, cookie);
  assert.equal(ended.status, 200);
  await transcript(cancelled.callId, acceptance);
  assert.equal(await status(cancelled.bookingId), 'cancelled');
  assert.deepEqual(await backupCalls(cancelled.requestId), []);
  console.log('PASS a late transcript cannot revive a booking cancelled by the customer.');

  const expired = await setup();
  await database.query(`UPDATE ${table('provider_offers')} SET visit_at = clock_timestamp() - interval '1 hour' WHERE id = $1`, [expired.offers[1]]);
  await claim(expired.callId);
  await transcript(expired.callId, 'Agent: Can you confirm?\nYou: I cannot attend.');
  assert.equal(await status(expired.bookingId), 'cancelled');
  assert.deepEqual(await backupCalls(expired.requestId), []);
  console.log('PASS an expired backup is never called.');
  await testConfirmationRetryFlow(context, setup);
  await testConfirmationPolicyFlow(context, setup);
}
