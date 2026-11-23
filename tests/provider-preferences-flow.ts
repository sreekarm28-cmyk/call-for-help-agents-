import assert from 'node:assert/strict';
import { confirmationLabel } from '../src/confirmation-status.js';
import { waitFor, type FlowContext } from './flow-helpers.js';

export async function testProviderPreferencesFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, post, env } = context;
  const t = (name: string) => `"${schema}".${name}`;
  const { rows: [request] } = await database.query<{ id: string }>(
    `INSERT INTO ${t('service_requests')} (user_id,service_type,description,contact_name,contact_phone,
      service_address,preferred_date,preferred_time_window,preferred_language,collect_offers)
     SELECT id,'plumber','Preference test','Tester','+919999900001','Strict test address',CURRENT_DATE+2,'any','te',true
     FROM ${t('users')} WHERE email='provider-flow@example.test' RETURNING id`,
  );
  const transcript = 'Agent: When can you visit?\nYou: Maybe tomorrow, I am not sure about the time.';
  const ids: string[] = [];
  for (const rank of [1, 2, 3]) {
    await database.query(`INSERT INTO ${t('request_providers')} (request_id,google_place_id,rank,expires_at)
      VALUES ($1,$2,$3,clock_timestamp()+interval '3 days')`, [request.id, `test-place-${rank}`, rank]);
    if (rank === 3) continue;
    const { rows: [call] } = await database.query<{ id: string }>(
      `INSERT INTO ${t('call_attempts')} (request_id,google_place_id,status,transcript,started_at,ended_at)
       VALUES ($1,$2,'transcript_received',$3,clock_timestamp(),clock_timestamp()) RETURNING id`,
      [request.id, `test-place-${rank}`, transcript],
    );
    ids.push(call.id);
    await database.query(`INSERT INTO ${t('call_extractions')} (call_attempt_id,extraction_status,provider_response)
      VALUES ($1,'completed','needs_clarification')`, [call.id]);
  }
  const path = `/api/me/requests/${request.id}`;
  const read = async () => {
    const response = await fetch(baseUrl + path + '/offers', { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const save = (first = ids[0], backup: string | null = ids[1], session = cookie) => post(path + '/provider-choices',
    { primaryCallId: first, backupCallId: backup }, session);
  assert.equal((await post(path + '/provider-choices', { primaryCallId: ids[0] })).status, 401);
  assert.equal((await save(ids[0], ids[0])).status, 400);
  await database.query(`INSERT INTO ${t('call_attempts')} (request_id,google_place_id)
    VALUES ($1,'test-place-3')`, [request.id]);
  const initial = await read();
  assert.equal(initial.offers.length, 2);
  assert.ok(initial.offers.every((o: { selectable: boolean; transcript: string }) => !o.selectable && o.transcript === transcript));
  assert.equal((await save()).status, 200);
  const saved = await read();
  assert.deepEqual(saved.preferences, { primaryPlaceId: 'test-place-1', backupPlaceId: 'test-place-2' });
  assert.equal(saved.booking, undefined);
  assert.equal((await database.query(`SELECT id FROM ${t('call_attempts')} WHERE request_id=$1 AND status='queued'`, [request.id])).rowCount, 0);
  assert.equal((await database.query(`SELECT id FROM ${t('bookings')} WHERE request_id=$1`, [request.id])).rowCount, 0);
  const dashboard = await fetch(baseUrl + '/api/me/requests', { headers: { cookie } });
  assert.deepEqual((await dashboard.json()).requests.find((r: { id: number | string }) => String(r.id) === request.id).preferences, saved.preferences);
  const names = await fetch(baseUrl + path + '/booking-choices', { headers: { cookie } });
  const choices = await names.json();
  assert.equal(choices.bookingId, `preferences-${request.id}`);
  assert.equal(choices.primary.name, 'Test Plumber 1');
  assert.equal(choices.backup.name, 'Test Plumber 2');
  console.log('PASS unclear answers expose the exact transcript and first/backup preferences persist without creating a booking or placing a call.');

  const other = await post('/api/auth/register', { email: 'preferences-other@example.test', password: 'test-password-1234' });
  assert.equal(other.status, 201);
  assert.equal((await save(ids[0], ids[1], other.headers.get('set-cookie')!.split(';')[0])).status, 404);
  assert.equal((await save(ids[0], '9223372036854775806')).status, 409);
  context.startWorker();
  const recalled = await post(path + `/calls/${ids[0]}/recall`, {}, cookie);
  assert.equal(recalled.status, 201);
  const callId = (await recalled.json()).callAttemptId;
  const headers = { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' };
  const internal = (route: string, body: object) => fetch(baseUrl + route, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: callId })).status, 200);
  assert.equal((await internal(`/api/internal/call-attempts/${callId}/transcript`, {
    transcript: 'Agent: What is the fee and time?\nYou: The visit is ₹350 for inspection. Tomorrow at 1 p.m. Repair is ₹700 to ₹900, parts extra.',
  })).status, 201);
  const ready = await waitFor('preferred provider to provide complete terms', async () => {
    const current = await read();
    assert.deepEqual(current.preferences, saved.preferences);
    return current.offers.find((o: { callAttemptId: string; selectable: boolean }) => o.callAttemptId === callId && o.selectable);
  });
  assert.equal((await database.query(`SELECT status FROM ${t('call_attempts')}
    WHERE request_id=$1 AND google_place_id='test-place-3'`, [request.id])).rows[0].status, 'cancelled');
  assert.equal((await read()).booking, undefined);
  console.log('PASS a user-requested recall preserves preferences across new call IDs and never automatically calls unchosen vendors.');

  const selected = await post(path + `/offers/${ready.id}/select`, {}, cookie);
  assert.equal(selected.status, 201);
  const booking = (await selected.json()).booking;
  const { rows: [confirmation] } = await database.query<{ id: string }>(
    `SELECT id FROM ${t('call_attempts')} WHERE confirmation_booking_id=$1`, [booking.id],
  );
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: confirmation.id })).status, 200);
  const unclearText = 'Agent: Do you confirm this booking?\nYou: Maybe, call me later.';
  await internal(`/api/internal/call-attempts/${confirmation.id}/transcript`, { transcript: unclearText });
  const reviewed = await waitFor('unclear confirmation to be shown beside its transcript', async () => {
    const current = await read();
    return current.booking?.confirmation?.decision === 'needs_clarification' ? current.booking : undefined;
  });
  assert.equal(reviewed.confirmation.transcript, unclearText);
  assert.equal(confirmationLabel(reviewed.status, reviewed.confirmation), 'Answer was not clear');
  assert.equal((await save(callId, ids[1])).status, 409);
  assert.equal((await post(path + `/bookings/${booking.id}/end`, { reason: 'cancelled', findReplacement: false }, cookie)).status, 200);
  assert.equal((await save(ids[1], callId)).status, 200);
  assert.deepEqual((await read()).preferences, { primaryPlaceId: 'test-place-2', backupPlaceId: 'test-place-1' });
  assert.equal((await read()).booking, undefined);
  assert.equal(confirmationLabel('awaiting_provider_confirmation', { status: 'failed', attemptCount: 3, attemptLimit: 3 }),
    'Could not confirm — attempt limit reached');
  console.log('PASS unclear confirmation shows its own transcript; the user can release the pending booking and choose either vendor again.');
}
