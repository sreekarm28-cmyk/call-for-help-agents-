import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type FlowContext, type SearchStatus } from './flow-helpers.js';

export async function testRequestFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, post } = context;
  const scenarios = [
    // Keep the initial scenarios stable for the booking and extraction fixtures.
    { address: 'Strict test address', expected: { providerCount: 5, candidateCount: 12, eligibleCount: 7,
      strictPassCount: 7, shortfall: 0, ratingFallbackUsed: false, ratingCutoff: 4 } },
    { address: 'Fallback test address', expected: { providerCount: 5, strictPassCount: 1,
      shortfall: 0, ratingFallbackUsed: true, ratingCutoff: null } },
    { address: 'Unrated test address', expected: { providerCount: 1, strictPassCount: 0,
      shortfall: 4, ratingFallbackUsed: true, ratingCutoff: null } },
    { address: 'Empty test address', expected: { providerCount: 0, candidateCount: 0, shortfall: 5,
      ratingFallbackUsed: false } },
    { address: 'Custom trade test address', service: 'AC repair', expected: { providerCount: 1,
      shortfall: 4, ratingFallbackUsed: false } },
    { address: 'Test street, Bengaluru 560038', expected: { providerCount: 5 } },
    { address: 'Places failure test address', expected: { status: 'failed', errorCode: 'search_failed' } },
    { address: 'Strict test address', expiredAttempts: 1, expected: { providerCount: 5 } },
    { address: 'Strict test address', expiredAttempts: 3,
      expected: { status: 'failed', errorCode: 'search_timed_out' } },
    { address: 'Legacy test address', expected: { providerCount: 5 } },
  ];
  const requests = context.requests;
  const preferredDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const validRequest = {
    serviceType: 'plumber', description: 'Integration test', serviceAddress: 'Strict test address',
    contactName: 'Test User', contactPhone: '+91 99999 00000', preferredDate,
    preferredTimeWindow: 'any', maxVisitFee: null, bookingPermission: 'approval',
  };
  for (const address of ['Unknown test address', 'Ambiguous test address']) {
    const result = await post('/api/service-requests', {
      ...validRequest, serviceAddress: address, rememberDetails: true,
    }, cookie, randomUUID());
    assert.equal(result.status, 422);
    assert.equal((await result.json()).errorCode, 'address_unresolved');
  }
  const structuredAddress = { addressDoor: 'Flat 12, Test Building', addressStreet: 'Test street', addressAreaCity: 'Bengaluru', addressPinCode: '560038' };
  const mismatched = await post('/api/service-requests', {
    ...validRequest, ...structuredAddress, addressPinCode: '560039', rememberDetails: true,
  }, cookie, randomUUID());
  assert.equal(mismatched.status, 422);
  assert.equal((await mismatched.json()).errorCode, 'address_unresolved');
  for (const invalid of [
    { preferredDate: '2028-02-30' }, { preferredDate: '2000-01-01' }, { contactPhone: '1------' },
    { ...structuredAddress, addressPinCode: '56003' }, { ...structuredAddress, addressAreaCity: ' ' },
    { ...structuredAddress, addressDoor: ' ' },
  ]) {
    const result = await post('/api/service-requests', { ...validRequest, ...invalid }, cookie, randomUUID());
    assert.equal(result.status, 400);
    await result.text();
  }
  const { rows: [saved] } = await database.query(
    `SELECT EXISTS (SELECT 1 FROM "${schema}".service_requests) AS request_saved,
            EXISTS (SELECT 1 FROM "${schema}".scheduled_jobs) AS job_saved,
            EXISTS (SELECT 1 FROM "${schema}".users WHERE service_address IS NOT NULL) AS profile_changed`,
  );
  assert.deepEqual(saved, { request_saved: false, job_saved: false, profile_changed: false });
  console.log('PASS rejects unresolved addresses and invalid dates or phone numbers before saving');
  for (const [index, scenario] of scenarios.entries()) {
    const body = {
      serviceType: scenario.service ? 'other' : 'plumber', customService: scenario.service,
      description: 'Integration test', serviceAddress: scenario.address,
      contactName: 'Test User', contactPhone: '+91 99999 00000', preferredDate,
      preferredTimeWindow: 'any', maxVisitFee: null,
      bookingPermission: 'approval',
      ...(scenario.address === 'Test street, Bengaluru 560038' ? { ...structuredAddress, rememberDetails: true } : {}),
    };
    const submissionId = randomUUID();
    const send = (): Promise<Response> => post('/api/service-requests', body, cookie, submissionId);
    const [response, replay] = index === 0
      ? (await Promise.all([send(), send()])).sort((a, b) => b.status - a.status)
      : [await send()];
    const submitted = await response.json() as { requestId: number };
    assert.equal(response.status, 201, JSON.stringify(submitted));
    const { rows: [location] } = await database.query(
      `SELECT latitude, longitude, preferred_language FROM "${schema}".service_requests WHERE id = $1`, [submitted.requestId],
    );
    assert.equal(typeof location.latitude, 'number');
    assert.equal(location.longitude, 77.6);
    assert.equal(location.preferred_language, scenario.address === 'Test street, Bengaluru 560038' ? 'kn' : 'te');
    if (scenario.address === 'Legacy test address') {
      await database.query(
        `UPDATE "${schema}".service_requests SET latitude = NULL, longitude = NULL WHERE id = $1`,
        [submitted.requestId],
      );
    }
    if (scenario.address === 'Test street, Bengaluru 560038') {
      const { rows: [address] } = await database.query(
        `SELECT r.service_address, u.service_address AS saved_address
         FROM "${schema}".service_requests r JOIN "${schema}".users u ON u.id = r.user_id
         WHERE r.id = $1`, [submitted.requestId],
      );
      assert.deepEqual(address, {
        service_address: 'Flat 12, Test Building\nTest street\nBengaluru\n560038',
        saved_address: 'Flat 12, Test Building\nTest street\nBengaluru\n560038',
      });
    }
    if (replay) {
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), submitted);
      const { rows: [jobs] } = await database.query(
        `SELECT count(*)::int AS count FROM "${schema}".scheduled_jobs`,
      );
      assert.equal(jobs.count, 1);
      console.log('PASS concurrent duplicate submission creates one job');
      await database.query(
        `UPDATE "${schema}".request_rate_limits SET count = 20 WHERE key LIKE 'service-request-user:%'`,
      );
      const rejected = await post('/api/service-requests', body, cookie, randomUUID());
      assert.equal(rejected.status, 429);
      assert.ok(Number(rejected.headers.get('Retry-After')) > 0);
      await rejected.text();
      const retry = await send();
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), submitted);
      await database.query(
        `UPDATE "${schema}".request_rate_limits SET count = 1 WHERE key LIKE 'service-request-user:%'`,
      );
      console.log('PASS search limit allows replay without adding a job');
    }
    const path = `/api/me/requests/${submitted.requestId}/provider-search`;
    const status: Response = await fetch(baseUrl + path, { headers: { cookie }, signal: AbortSignal.timeout(5_000) });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as SearchStatus).status, 'pending');
    if (scenario.expiredAttempts) {
      await database.query(
        `UPDATE "${schema}".scheduled_jobs
         SET status = 'running', attempt_count = $2, lease_expires_at = NOW() - INTERVAL '1 second'
         WHERE request_id = $1`,
        [submitted.requestId, scenario.expiredAttempts],
      );
    }
    requests.push({ ...scenario, path, requestId: submitted.requestId });
  }

}
