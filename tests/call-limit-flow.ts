import assert from 'node:assert/strict';
import { waitFor, type FlowContext } from './flow-helpers.js';

export async function testCallLimitFlow(context: FlowContext) {
  const { baseUrl, database, schema, env } = context;
  const table = (name: string) => `"${schema}".${name}`;
  const headers = { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' };
  const claim = (id: string) => fetch(baseUrl + '/api/internal/test-calls/claim', {
    method: 'POST', headers, body: JSON.stringify({ callAttemptId: id }),
  });
  const user = async (email: string) => (await database.query<{ id: string }>(
    `INSERT INTO ${table('users')} (email, password_hash) VALUES ($1, 'test-only') RETURNING id`, [email],
  )).rows[0].id;
  // All fixtures live in the runner's isolated schema. No phone API is used.
  const pending = async (userId: string, placeId: string, queue = true) => {
    await database.query('BEGIN');
    try {
      const { rows: [request] } = await database.query<{ id: string }>(
        `INSERT INTO ${table('service_requests')}
         (user_id, service_type, description, contact_name, contact_phone, service_address,
          preferred_date, preferred_time_window, collect_offers, preferred_language)
         VALUES ($1, 'plumber', 'Call limit test', 'Tester', '+919999900001', 'Strict test address',
                 CURRENT_DATE + 1, 'any', true, 'te') RETURNING id`, [userId],
      );
      await database.query(
        `INSERT INTO ${table('request_providers')} (request_id, google_place_id, rank, expires_at)
         VALUES ($1, $2, 1, CURRENT_TIMESTAMP + interval '2 days')`, [request.id, placeId],
      );
      const call = queue ? (await database.query<{ id: string }>(
        `INSERT INTO ${table('call_attempts')} (request_id, google_place_id) VALUES ($1, $2) RETURNING id`,
        [request.id, placeId],
      )).rows[0] : null;
      await database.query('COMMIT');
      return { requestId: request.id, id: call?.id ?? '' };
    } catch (error) { await database.query('ROLLBACK'); throw error; }
  };
  const finish = async (id: string) => {
    await database.query(
      `UPDATE ${table('service_requests')} SET collect_offers = false
       WHERE id = (SELECT request_id FROM ${table('call_attempts')} WHERE id = $1)`, [id],
    );
    const response = await fetch(baseUrl + `/api/internal/call-attempts/${id}/outcome`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'failed' }),
    });
    assert.equal(response.status, 200);
  };
  const run = async (id: string) => {
    const response = await claim(id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).callAttemptId, id);
    await finish(id);
  };
  const counted = async (userId: string) => (await database.query<{ vendors: number; attempts: number }>(
    `SELECT count(DISTINCT c.google_place_id)::int AS vendors, count(*)::int AS attempts
     FROM ${table('call_attempts')} c JOIN ${table('service_requests')} r ON r.id = c.request_id
     WHERE r.user_id = $1 AND (c.started_at IS NOT NULL OR c.transcript IS NOT NULL)`, [userId],
  )).rows[0];

  const owner = await user('vendor-limit@example.test');
  const first = await pending(owner, 'limit-vendor-1');
  await run(first.id);
  for (let repeat = 0; repeat < 2; repeat++) await run((await pending(owner, 'limit-vendor-1')).id);
  assert.deepEqual(await counted(owner), { vendors: 1, attempts: 3 });
  for (let vendor = 2; vendor <= 9; vendor++) await run((await pending(owner, `limit-vendor-${vendor}`)).id);

  const contenders = [await pending(owner, 'limit-vendor-10'), await pending(owner, 'limit-vendor-11')];
  const claims = await Promise.all(contenders.map(({ id }) => claim(id)));
  assert.deepEqual(claims.map(({ status }) => status).sort(), [200, 204]);
  const winner = claims.findIndex(({ status }) => status === 200);
  await finish(contenders[winner].id);
  assert.equal((await claim(contenders[1 - winner].id)).status, 204);
  assert.equal((await counted(owner)).vendors, 10);
  console.log('PASS repeat attempts count as one vendor; concurrent claims cannot admit an eleventh vendor.');

  await run((await pending(owner, 'limit-vendor-1')).id);
  assert.deepEqual(await counted(owner), { vendors: 10, attempts: 13 });
  console.log('PASS repeat calls remain allowed after ten vendors, across different requests and failed calls.');

  // The limit must preserve existing confirmation callbacks to known vendors.
  const { rows: [offer] } = await database.query<{ id: string }>(
    `INSERT INTO ${table('provider_offers')} (request_id, call_attempt_id, visit_at, visit_fee)
     VALUES ($1, $2, CURRENT_TIMESTAMP + interval '1 day', 200) RETURNING id`, [first.requestId, first.id],
  );
  const { rows: [booking] } = await database.query<{ id: string }>(
    `INSERT INTO ${table('bookings')} (request_id, offer_id) VALUES ($1, $2) RETURNING id`,
    [first.requestId, offer.id],
  );
  const { rows: [confirmation] } = await database.query<{ id: string }>(
    `WITH inserted AS (INSERT INTO ${table('call_attempts')} (request_id, google_place_id, confirmation_booking_id)
     VALUES ($1, 'limit-vendor-1', $2) RETURNING id, confirmation_booking_id)
     UPDATE ${table('bookings')} b SET confirmation_call_attempt_id = inserted.id
     FROM inserted WHERE b.id = inserted.confirmation_booking_id RETURNING inserted.id`, [first.requestId, booking.id],
  );
  await claim(contenders[1 - winner].id);
  const { rows: [retained] } = await database.query(
    `SELECT status FROM ${table('call_attempts')} WHERE id = $1`, [confirmation.id],
  );
  assert.equal(retained.status, 'queued');
  console.log('PASS the vendor limit preserves confirmation callbacks to previously contacted vendors.');

  context.startWorker();
  const newProvider = await pending(owner, 'limit-vendor-12', false);
  const knownProvider = await pending(owner, 'limit-vendor-1', false);
  const queued = await waitFor('worker to queue a known vendor after the limit', async () => {
    const { rows: [call] } = await database.query<{ id: string }>(
      `SELECT id FROM ${table('call_attempts')} WHERE request_id = $1 AND status = 'queued'`, [knownProvider.requestId],
    );
    return call?.id;
  });
  assert.equal((await database.query(
    `SELECT id FROM ${table('call_attempts')} WHERE request_id = $1`, [newProvider.requestId],
  )).rowCount, 0);
  await run(queued);
  console.log('PASS the scheduler queues known vendors after the limit and blocks new vendors.');

  const secondOwner = await user('independent-vendor-limit@example.test');
  await run((await pending(secondOwner, 'limit-vendor-12')).id);
  assert.deepEqual(await counted(secondOwner), { vendors: 1, attempts: 1 });
  console.log('PASS another account has its own ten-vendor allowance.');
}
