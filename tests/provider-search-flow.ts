import assert from 'node:assert/strict';
import { waitFor, type FlowContext, type SearchStatus } from './flow-helpers.js';

export async function testProviderSearchFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, requests } = context;
  const worker = context.startWorker();
  for (const request of requests) {
    const outcome = await waitFor<SearchStatus>(request.address, async () => {
      worker!.check();
      const response: Response = await fetch(baseUrl + request.path, {
        headers: { cookie }, signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200);
      const result = await response.json() as SearchStatus;
      if (result.status === 'completed' || result.status === 'failed') return result;
    });
    const expected = { status: 'completed', ...request.expected };
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(outcome[field as keyof SearchStatus], value, `${request.address}: ${field}`);
    }
    const { rows: [event] } = await database.query<{ metadata: { placeIds?: string[] } }>(
      `SELECT metadata FROM "${schema}".request_events
       WHERE request_id = $1 AND event_type = 'provider_search' ORDER BY id DESC LIMIT 1`,
      [request.requestId],
    );
    assert.ok(event, 'The worker must save the outcome.');
    if (outcome.status === 'completed') {
      assert.equal(event.metadata.placeIds?.length, outcome.providerCount);
    }
    if (request.address === 'Fallback test address') {
      assert.deepEqual(event.metadata.placeIds, [
        'test-place-1', 'test-place-2', 'test-place-3', 'test-place-4', 'test-place-5',
      ]);
    }
    if (request.address === 'Legacy test address') {
      const { rows: [location] } = await database.query(
        `SELECT latitude, longitude FROM "${schema}".service_requests WHERE id = $1`, [request.requestId],
      );
      assert.deepEqual(location, { latitude: 12.97, longitude: 77.6 });
      console.log('PASS resolves and saves coordinates for requests created before the migration.');
    }
    if (request.address === 'Strict test address' && outcome.status === 'completed') {
      assert.deepEqual(event.metadata.placeIds, ['test-place-1', 'test-place-2', 'test-place-3',
        'test-place-4', 'test-place-5']);
      const response: Response = await fetch(baseUrl + `/api/me/requests/${request.requestId}/providers`, {
        headers: { cookie }, signal: AbortSignal.timeout(8_000),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        providers: Array.from({ length: 5 }, (_, index) => ({
          name: `Test Plumber ${index + 1}`, area: 'Indiranagar',
        })),
      });
    }
    if (request.expiredAttempts) {
      const { rows: [job] } = await database.query(
        `SELECT attempt_count, lease_expires_at FROM "${schema}".scheduled_jobs WHERE request_id = $1`,
        [request.requestId],
      );
      assert.equal(job.attempt_count, outcome.status === 'completed' ? request.expiredAttempts + 1 : 3);
      assert.equal(job.lease_expires_at, null);
    }
    if (request.address === 'Places failure test address') {
      const { rows: [job] } = await database.query(
        `SELECT attempt_count, lease_expires_at FROM "${schema}".scheduled_jobs WHERE request_id = $1`,
        [request.requestId],
      );
      assert.equal(job.attempt_count, 3);
      assert.equal(job.lease_expires_at, null);
    }
    console.log(`PASS ${request.address}${request.expiredAttempts ? ` after ${request.expiredAttempts} expired attempts` : ''}`, {
      status: outcome.status, fetched: outcome.candidateCount, passed: outcome.strictPassCount,
      shortlisted: outcome.providerCount, cutoff: outcome.ratingCutoff, shortfall: outcome.shortfall,
      error: outcome.errorCode,
    });
  }
}
