import assert from 'node:assert/strict';
import { waitFor, type FlowContext } from './flow-helpers.js';

export async function testReplacementFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, post, requests, bookingId, env } = context;
  const requestId = requests[0].requestId;
  // Expire the previous shortlist and remaining offers before asking for a replacement.
  await database.query(`UPDATE "${schema}".request_providers SET expires_at = now() - interval '1 minute'
    WHERE request_id = $1`, [requestId]);
  await database.query(`UPDATE "${schema}".provider_offers SET visit_at = now() - interval '1 hour'
    WHERE request_id = $1`, [requestId]);
  const report = () => post(`/api/me/requests/${requestId}/bookings/${bookingId}/end`,
    { reason: 'no_show', findReplacement: true }, cookie);
  const reports = await Promise.all([report(), report()]);
  assert.deepEqual(reports.map(({ status }) => status), [200, 200]);
  await waitFor('replacement search', async () => {
    const { rows: jobs } = await database.query(
      `SELECT status FROM "${schema}".scheduled_jobs WHERE request_id = $1 ORDER BY id`, [requestId],
    );
    assert.ok(jobs.length <= 2);
    return jobs.length === 2 && jobs[1].status === 'completed' ? true : undefined;
  });
  const { rows: shortlist } = await database.query(
    `SELECT google_place_id FROM "${schema}".request_providers WHERE request_id = $1 ORDER BY rank`, [requestId],
  );
  assert.equal(shortlist[0]?.google_place_id, 'test-place-3');
  const { rows: [closed] } = await database.query(
    `SELECT status FROM "${schema}".bookings WHERE id = $1`, [bookingId],
  );
  assert.equal(closed.status, 'no_show');
  const dashboard = await fetch(baseUrl + '/api/me/requests', { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  const { requests: dashboardRequests } = await dashboard.json() as {
    requests: { id: string | number; bookings: { id: string; status: string }[] }[];
  };
  assert.ok(dashboardRequests.find(({ id }) => String(id) === String(requestId))
    ?.bookings.some(({ id, status }) => id === bookingId && status === 'no_show'));
  const contacts = await fetch(baseUrl + `/api/me/requests/${requestId}/providers?contact=true`, { headers: { cookie } });
  assert.equal(contacts.status, 200);
  assert.equal((await contacts.json()).providers[0]?.phone, env.TEST_PHONE_NUMBER);
  console.log('PASS expires shortlist, preserves booking history, and deduplicates replacement searches.');
}
