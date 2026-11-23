import assert from 'node:assert/strict';
import pg from 'pg';
import { advanceBookingConfirmation } from '../server/bookings/booking-confirmation.js';
import { waitFor, type FlowContext } from './flow-helpers.js';

type Fixture = { requestId: string; bookingId: string; callId: string; offers: string[] };

export async function testConfirmationRetryFlow(context: FlowContext, setup: () => Promise<Fixture>) {
  const { database, schema, baseUrl, cookie, env, post } = context;
  const table = (name: string) => `"${schema}".${name}`;
  const headers = { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' };
  const internal = (path: string, body: object) => fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const read = async (fixture: Fixture) => {
    const response = await fetch(baseUrl + `/api/me/requests/${fixture.requestId}/offers`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const path = (f: Fixture) => `/api/me/requests/${f.requestId}/bookings/${f.bookingId}/retry-confirmation`;
  const f = await setup();
  assert.equal((await post(path(f), { callAttemptId: f.callId })).status, 401);
  assert.equal((await post(path(f), {}, cookie)).status, 400);
  assert.equal((await post(path(f), { callAttemptId: f.callId }, cookie)).status, 409, 'Cannot retry a queued call.');
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: f.callId })).status, 200);
  assert.equal((await internal(`/api/internal/call-attempts/${f.callId}/outcome`, { status: 'failed' })).status, 200);
  assert.equal((await read(f)).booking.confirmation.canRetry, true);

  // Add previously attempted vendors to fill the quota; a repeat vendor must still work.
  await database.query(
    `INSERT INTO ${table('call_attempts')} (request_id, google_place_id, status, started_at, ended_at)
     SELECT $1, 'retry-history-' || number, 'failed', clock_timestamp(), clock_timestamp()
     FROM generate_series(1, 10) number`, [f.requestId],
  );
  const clicks = await Promise.all([1, 2].map(() => post(path(f), { callAttemptId: f.callId }, cookie)));
  assert.deepEqual(clicks.map(({ status }) => status).sort(), [200, 201]);
  const results = await Promise.all(clicks.map((response) => response.json()));
  assert.equal(results[0].callAttemptId, results[1].callAttemptId);
  const retryId = results[0].callAttemptId as string;
  assert.notEqual(retryId, f.callId);
  const { rows: history } = await database.query(
    `SELECT id, status, google_place_id FROM ${table('call_attempts')} WHERE confirmation_booking_id = $1 ORDER BY id`, [f.bookingId],
  );
  assert.deepEqual(history.map(({ status }) => status), ['failed', 'queued']);
  assert.ok(history.every(({ google_place_id }) => google_place_id === 'test-place-1'));
  assert.equal((await read(f)).booking.confirmation.canRetry, false);
  console.log('PASS concurrent retry clicks create one new primary call, preserve history, and work beyond the vendor quota.');

  // Simulate an obsolete result arriving after the new attempt was queued.
  await database.query(`UPDATE ${table('call_attempts')} SET status = 'declined' WHERE id = $1`, [f.callId]);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [f.requestId]);
    await advanceBookingConfirmation(client, f.requestId);
    await client.query('COMMIT');
  } finally { client.release(); await pool.end(); }
  assert.equal((await read(f)).booking.status, 'awaiting_provider_confirmation');
  assert.equal((await database.query(
    `SELECT id FROM ${table('call_attempts')} WHERE request_id = $1 AND confirmation_booking_id IS NOT NULL
       AND google_place_id = 'test-place-2'`, [f.requestId],
  )).rowCount, 0);
  await database.query(`UPDATE ${table('call_attempts')} SET status = 'failed' WHERE id = $1`, [f.callId]);
  console.log('PASS an obsolete refusal cannot cancel the current attempt or trigger the backup.');

  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: retryId })).status, 200);
  assert.equal((await post(path(f), { callAttemptId: retryId }, cookie)).status, 409);
  // Hold extraction pending deterministically while checking the retry guard.
  await database.query(
    `UPDATE ${table('call_attempts')} SET status = 'transcript_received', ended_at = clock_timestamp(), transcript = $2 WHERE id = $1`,
    [retryId, 'Agent: Please confirm the agreed terms.\nYou: I accept those terms.'],
  );
  await database.query(
    `INSERT INTO ${table('call_extractions')} (call_attempt_id, available_at) VALUES ($1, clock_timestamp() + interval '1 hour')`, [retryId],
  );
  assert.equal((await post(path(f), { callAttemptId: retryId }, cookie)).status, 409);
  await database.query(`UPDATE ${table('call_extractions')} SET available_at = clock_timestamp() WHERE call_attempt_id = $1`, [retryId]);
  await waitFor('retry to confirm the booking', async () => (await read(f)).booking?.status === 'confirmed' ? true : undefined);
  assert.equal((await post(path(f), { callAttemptId: retryId }, cookie)).status, 409);
  assert.equal((await database.query(
    `SELECT id FROM ${table('call_attempts')} WHERE confirmation_booking_id = $1`, [f.bookingId],
  )).rowCount, 2);
  console.log('PASS calling, transcript review, and confirmed bookings cannot be retried; a successful retry confirms the primary.');

  const unclear = await setup();
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: unclear.callId })).status, 200);
  const text = 'Agent: Can you confirm?\nYou: Maybe, call me later.';
  assert.equal((await internal(`/api/internal/call-attempts/${unclear.callId}/transcript`, { transcript: text })).status, 201);
  await waitFor('unclear result to become retryable', async () => (await read(unclear)).booking?.confirmation?.canRetry ? true : undefined);
  const retried = await post(path(unclear), { callAttemptId: unclear.callId }, cookie);
  assert.equal(retried.status, 201);
  const newId = (await retried.json()).callAttemptId;
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: newId })).status, 200);
  assert.equal((await internal(`/api/internal/call-attempts/${newId}/outcome`, { status: 'failed' })).status, 200);
  const replay = await post(path(unclear), { callAttemptId: unclear.callId }, cookie);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).callAttemptId, newId, 'A delayed duplicate click cannot create yet another retry.');
  assert.equal((await database.query(
    `SELECT id FROM ${table('call_attempts')} WHERE confirmation_booking_id = $1`, [unclear.bookingId],
  )).rowCount, 2);
  console.log('PASS unclear answers can be retried; delayed duplicate requests do not redial.');

  const third = await post(path(unclear), { callAttemptId: newId }, cookie);
  assert.equal(third.status, 201);
  const thirdId = (await third.json()).callAttemptId;
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: thirdId })).status, 200);
  await internal(`/api/internal/call-attempts/${thirdId}/outcome`, { status: 'failed' });
  assert.equal((await post(path(unclear), { callAttemptId: thirdId }, cookie)).status, 409);
  assert.equal((await read(unclear)).booking.confirmation.canRetry, false);
  console.log('PASS manual retries cannot exceed the three-attempt primary limit.');

  const other = await post('/api/auth/register', { email: 'retry-other@example.test', password: 'test-password-1234' });
  assert.equal(other.status, 201);
  const otherCookie = other.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post(path(unclear), { callAttemptId: newId }, otherCookie)).status, 404);
  await database.query(`UPDATE ${table('provider_offers')} SET visit_at = clock_timestamp() - interval '1 hour' WHERE id = $1`, [unclear.offers[0]]);
  assert.equal((await read(unclear)).booking.confirmation.canRetry, false);
  assert.equal((await post(path(unclear), { callAttemptId: newId }, cookie)).status, 409);
  console.log('PASS other accounts and expired visit times cannot trigger retries.');

  const cancelled = await setup();
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: cancelled.callId })).status, 200);
  await internal(`/api/internal/call-attempts/${cancelled.callId}/outcome`, { status: 'failed' });
  assert.equal((await post(`/api/me/requests/${cancelled.requestId}/bookings/${cancelled.bookingId}/end`,
    { reason: 'cancelled', findReplacement: false }, cookie)).status, 200);
  assert.equal((await post(path(cancelled), { callAttemptId: cancelled.callId }, cookie)).status, 409);
  console.log('PASS a cancelled booking cannot be retried.');
}
