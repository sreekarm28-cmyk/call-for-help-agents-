import assert from 'node:assert/strict';
import { waitFor, type FlowContext } from './flow-helpers.js';

export async function testProviderRecallFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, post, env } = context;
  const t = (name: string) => `"${schema}".${name}`;
  const { rows: [request] } = await database.query<{ id: string }>(
    `INSERT INTO ${t('service_requests')} (user_id,service_type,description,contact_name,contact_phone,
      service_address,preferred_date,preferred_time_window,preferred_language,collect_offers)
     SELECT id,'plumber','Recall test','Tester','+919999900001','Strict test address',CURRENT_DATE+2,'any','te',true
     FROM ${t('users')} WHERE email='provider-flow@example.test' RETURNING id`,
  );
  const calls: string[] = [];
  let oldOffer = '';
  for (const rank of [1, 2]) {
    await database.query(`INSERT INTO ${t('request_providers')} (request_id,google_place_id,rank,expires_at)
      VALUES ($1,$2,$3,clock_timestamp()+interval '3 days')`, [request.id, `test-place-${rank}`, rank]);
    const { rows: [call] } = await database.query<{ id: string }>(
      `INSERT INTO ${t('call_attempts')} (request_id,google_place_id,status,started_at,ended_at)
       VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp()) RETURNING id`,
      [request.id, `test-place-${rank}`, rank === 1 ? 'transcript_received' : 'offer_received'],
    );
    calls.push(call.id);
    await database.query(`INSERT INTO ${t('call_extractions')} (call_attempt_id,extraction_status,provider_response)
      VALUES ($1,'completed',$2)`, [call.id, rank === 1 ? 'needs_clarification' : 'offer_received']);
    if (rank === 2) oldOffer = (await database.query<{ id: string }>(
      `INSERT INTO ${t('provider_offers')} (request_id,call_attempt_id,visit_at,visit_fee)
       VALUES ($1,$2,clock_timestamp()+interval '2 days',300) RETURNING id`, [request.id, call.id],
    )).rows[0].id;
  }
  const read = async () => {
    const response = await fetch(baseUrl + `/api/me/requests/${request.id}/offers`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const recall = (id: string, sessionCookie = cookie) => post(`/api/me/requests/${request.id}/calls/${id}/recall`, {}, sessionCookie);
  const headers = { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' };
  const internal = (path: string, body: object) => fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const initial = await read();
  assert.equal(initial.offers.length, 2);
  assert.equal(initial.offers.find((o: { callAttemptId: string }) => o.callAttemptId === calls[0]).selectable, false);
  assert.equal(initial.offers.find((o: { callAttemptId: string }) => o.callAttemptId === calls[0]).recallBlockedReason, null);

  // Fill the new-vendor quota on a separate request to verify this remains a repeat call.
  const { rows: [history] } = await database.query<{ id: string }>(
    `INSERT INTO ${t('service_requests')} (user_id,service_type,description,contact_name,contact_phone,
      service_address,preferred_date,preferred_time_window)
     SELECT user_id,service_type,description,contact_name,contact_phone,service_address,preferred_date,preferred_time_window
     FROM ${t('service_requests')} WHERE id=$1 RETURNING id`, [request.id],
  );
  await database.query(`INSERT INTO ${t('call_attempts')} (request_id,google_place_id,status,started_at)
    SELECT $1,'recall-quota-'||n,'failed',clock_timestamp() FROM generate_series(1,10) n`, [history.id]);
  assert.equal((await post(`/api/me/requests/${request.id}/calls/${calls[0]}/recall`, {})).status, 401);
  const clicks = await Promise.all([recall(calls[0]), recall(calls[0])]);
  assert.deepEqual(clicks.map(({ status }) => status).sort(), [200, 201]);
  const queued = await Promise.all(clicks.map((response) => response.json()));
  const nextId = queued[0].callAttemptId;
  assert.equal(nextId, queued[1].callAttemptId);
  const pending = await read();
  assert.equal(pending.offers.length, 2, 'A recall updates one vendor card instead of adding a duplicate.');
  const newCard = pending.offers.find((o: { callAttemptId: string }) => o.callAttemptId === nextId);
  assert.equal(newCard.callStatus, 'queued');
  assert.equal(newCard.selectable, false);
  assert.ok(newCard.recallBlockedReason);
  assert.equal((await recall(calls[1])).status, 409, 'Do not overlap provider calls.');
  console.log('PASS an incomplete offer can be recalled beyond the vendor quota; duplicate clicks queue only one call.');

  context.startWorker();
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: nextId })).status, 200);
  const text = 'Agent: What is the fee and time?\nYou: The visit is ₹350 for inspection. Tomorrow at 1 p.m. Repair is ₹700 to ₹900, parts extra.';
  assert.equal((await internal(`/api/internal/call-attempts/${nextId}/transcript`, { transcript: text })).status, 201);
  const ready = await waitFor('recalled provider to supply a selectable offer', async () => {
    const offers = (await read()).offers;
    const current = offers.find((o: { callAttemptId: string }) => o.callAttemptId === nextId);
    return current?.selectable ? current : undefined;
  });
  assert.equal((await read()).offers.length, 2);
  assert.equal((await recall(calls[0])).status, 200, 'Replaying an old click must not redial after completion.');
  assert.equal((await database.query(`SELECT id FROM ${t('call_attempts')} WHERE request_id=$1 AND google_place_id='test-place-1'`, [request.id])).rowCount, 2);
  console.log('PASS the recall transcript is extracted, the same vendor becomes bookable, and old call history is retained.');

  const secondRecall = await recall(calls[1]);
  assert.equal(secondRecall.status, 201);
  const secondId = (await secondRecall.json()).callAttemptId;
  assert.equal((await post(`/api/me/requests/${request.id}/offers/${oldOffer}/select`, {}, cookie)).status, 404,
    'An outdated quote cannot be selected during a new provider call.');
  assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: secondId })).status, 200);
  await internal(`/api/internal/call-attempts/${secondId}/outcome`, { status: 'failed' });
  assert.equal((await read()).offers.find((o: { callAttemptId: string }) => o.callAttemptId === secondId).callStatus, 'failed');
  console.log('PASS failed recalls stay visible and outdated quotes cannot bypass the newest call.');

  const other = await post('/api/auth/register', { email: 'recall-other@example.test', password: 'test-password-1234' });
  assert.equal(other.status, 201);
  assert.equal((await recall(secondId, other.headers.get('set-cookie')!.split(';')[0])).status, 404);
  await database.query(`UPDATE ${t('request_providers')} SET expires_at=clock_timestamp()-interval '1 minute'
    WHERE request_id=$1 AND google_place_id='test-place-2'`, [request.id]);
  assert.equal((await recall(secondId)).status, 409);
  assert.equal((await post(`/api/me/requests/${request.id}/offers/${ready.id}/select`, {}, cookie)).status, 201);
  assert.equal((await recall(nextId)).status, 409);
  console.log('PASS recalls enforce account ownership, shortlist expiry, and existing booking selection.');
}
