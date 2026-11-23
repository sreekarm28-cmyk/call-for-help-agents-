import assert from 'node:assert/strict';
import { waitFor, type FlowContext } from './flow-helpers.js';

export async function testLlmExtractionFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, env, requests } = context;
  const extractionRequestId = requests[1].requestId;
  const { rows: [call] } = await database.query<{ id: string }>(
    `SELECT id FROM "${schema}".call_attempts WHERE request_id = $1 AND status = 'queued'`, [extractionRequestId],
  );
  assert.ok(call, 'The search worker should queue a call.');
  await database.query(`UPDATE "${schema}".service_requests SET preferred_language = NULL WHERE id = $1`, [extractionRequestId]);
  const languageUrl = baseUrl + `/api/internal/call-attempts/${call.id}/language`;
  assert.equal((await fetch(languageUrl)).status, 401);
  const languageResponse = await fetch(languageUrl, {
    headers: { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}` },
  });
  assert.equal(languageResponse.status, 200);
  assert.deepEqual(await languageResponse.json(), { preferredLanguage: 'te', languageName: 'Telugu' });
  const { rows: [resolvedLanguage] } = await database.query(
    `SELECT preferred_language FROM "${schema}".service_requests WHERE id = $1`, [extractionRequestId],
  );
  assert.equal(resolvedLanguage.preferred_language, 'te');
  console.log('PASS older requests resolve and save their state-based language before calling.');
  const contextUrl = baseUrl + `/api/internal/call-attempts/${call.id}/context`;
  assert.equal((await fetch(contextUrl)).status, 401);
  const contextResponse = await fetch(contextUrl, { headers: { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}` } });
  assert.equal(contextResponse.status, 200);
  const callContext = await contextResponse.json();
  assert.equal(callContext.phoneNumber, env.TEST_PHONE_NUMBER);
  assert.equal(callContext.testCall, true);
  assert.equal(callContext.request.description, 'Integration test');
  assert.equal(callContext.preferredLanguage, 'te');
  assert.equal('phone' in callContext.provider, false);
  const claim = () => fetch(baseUrl + '/api/internal/test-calls/claim', {
    method: 'POST', headers: { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ callAttemptId: call.id }),
  });
  const claims = await Promise.all([claim(), claim()]);
  assert.deepEqual(claims.map(({ status }) => status).sort(), [200, 204]);
  assert.equal((await claim()).status, 204);
  console.log('PASS database context uses only the test number and concurrent dispatch claims cannot duplicate a call.');
  const transcript = 'Agent: What is the visit fee and when can you come?\n' +
    'You: The visit is ₹350 for inspection. Tomorrow at 1 p.m. Repair is ₹700 to ₹900, parts extra.';
  const callback = (token: string, text = transcript) => fetch(
    baseUrl + `/api/internal/call-attempts/${call.id}/transcript`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcript: text }),
    },
  );
  assert.equal((await callback('wrong-token')).status, 401);
  assert.equal((await callback(env.CALL_TRANSCRIPT_TOKEN)).status, 201);
  assert.equal((await callback(env.CALL_TRANSCRIPT_TOKEN)).status, 200);
  assert.equal((await callback(env.CALL_TRANSCRIPT_TOKEN, transcript + '\nAgent: Thanks.')).status, 409);
  const readCall = async () => {
    const response = await fetch(baseUrl + `/api/me/requests/${extractionRequestId}/offers?details=true`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return (await response.json()).offers.find(({ callAttemptId }: { callAttemptId: string }) => callAttemptId === call.id);
  };
  const pending = await readCall();
  assert.equal(pending.extractionStatus, 'pending');
  assert.equal(pending.visitFee, null);
  assert.equal(pending.visitTime, null);
  assert.equal(pending.summary, null);
  assert.equal(pending.selectable, false);
  assert.equal(pending.transcript, transcript);
  await waitFor('extraction retry and booking offer', async () => {
    const { rows: [extraction] } = await database.query<{ extraction_status: string }>(
      `SELECT extraction_status FROM "${schema}".call_extractions WHERE call_attempt_id = $1`, [call.id],
    );
    assert.notEqual(extraction?.extraction_status, 'failed');
    return extraction?.extraction_status === 'completed' ? true : undefined;
  });
  const ready = await readCall();
  assert.equal(ready.extractionStatus, 'completed');
  assert.equal(ready.visitFee, '350.00');
  assert.equal(ready.feeCovers, 'Inspection');
  assert.equal(ready.repairFeeMin, '700.00');
  assert.equal(ready.repairFeeMax, '900.00');
  assert.equal(ready.repairCostNotes, 'Parts extra.');
  assert.equal(ready.visitTime, '13:00');
  assert.equal(ready.availabilityAsSaid, 'Tomorrow at 1 p.m.');
  assert.equal(ready.visitAt, ready.visitDate + 'T07:30:00.000Z');
  assert.equal(ready.summary, 'Visit tomorrow at 1 p.m. for ₹350.');
  assert.equal(ready.transcript, transcript);
  assert.equal(ready.selectable, true);
  const savedText = await fetch(baseUrl + `/api/me/requests/${extractionRequestId}/offers?transcripts=true`, {
    headers: { cookie },
  });
  assert.equal(savedText.status, 200);
  const transcriptOnly = (await savedText.json()).offers.find(({ callAttemptId }: { callAttemptId: string }) => callAttemptId === call.id);
  assert.equal(transcriptOnly.transcript, transcript);
  assert.equal(transcriptOnly.provider, null);
  const { rows: [savedExtraction] } = await database.query(
    `SELECT attempt_count, evidence FROM "${schema}".call_extractions WHERE call_attempt_id = $1`, [call.id],
  );
  assert.deepEqual(savedExtraction, { attempt_count: 2, evidence: ['The visit is ₹350'] });
  const { rows: [unanswered] } = await database.query<{ id: string }>(
    `SELECT id FROM "${schema}".call_attempts WHERE request_id = $1 AND status = 'queued' LIMIT 1`,
    [requests[2].requestId],
  );
  assert.ok(unanswered);
  const claimedUnanswered = await fetch(baseUrl + '/api/internal/test-calls/claim', {
    method: 'POST', headers: { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ callAttemptId: unanswered.id }),
  });
  assert.equal(claimedUnanswered.status, 200);
  const outcome = await fetch(baseUrl + `/api/internal/call-attempts/${unanswered.id}/outcome`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'no_answer' }),
  });
  assert.equal(outcome.status, 200);
  assert.deepEqual(await outcome.json(), { status: 'no_answer' });
  console.log('PASS unanswered test calls update their database status.');
  console.log('PASS saves the original transcript, shows pending, retries Gemini, and publishes the extracted booking offer.');
}
