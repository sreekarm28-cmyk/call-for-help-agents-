import assert from 'node:assert/strict';
import type { FlowContext } from './flow-helpers.js';

export async function testBookingVisibilityFlow(context: FlowContext) {
  const { database, schema, baseUrl, cookie, requests, bookingId } = context;
  const requestId = requests[0].requestId;
  const hidePath = baseUrl + `/api/me/requests/${requestId}/providers`;
  const hideCard = () => fetch(hidePath, { method: 'DELETE', headers: { cookie } });
  const hideCurrent = () => fetch(baseUrl + `/api/me/requests/${requestId}/current-booking`, { method: 'DELETE', headers: { cookie } });
  assert.equal((await hideCard()).status, 409, 'An upcoming visit card must stay visible.');
  assert.equal((await hideCurrent()).status, 409, 'An upcoming current booking card must stay visible.');
  await database.query(
    `UPDATE "${schema}".service_requests
     SET preferred_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - 1 WHERE id = $1`,
    [requestId],
  );
  assert.equal((await hideCurrent()).status, 204);
  const afterHideCurrent = await fetch(baseUrl + '/api/me/requests', { headers: { cookie } });
  const currentHiddenRequest = (await afterHideCurrent.json()).requests.find(({ id }: { id: string }) => String(id) === String(requestId));
  assert.equal(currentHiddenRequest?.currentBookingHidden, true);
  assert.equal(currentHiddenRequest.providersHidden, false);
  assert.equal((await hideCard()).status, 204);
  assert.equal((await hideCard()).status, 204);
  const afterDelete = await fetch(baseUrl + '/api/me/requests', { headers: { cookie } });
  const hiddenRequest = (await afterDelete.json()).requests.find(({ id }: { id: string }) => String(id) === String(requestId));
  assert.equal(hiddenRequest?.providersHidden, true);
  assert.ok(hiddenRequest.bookings.some(({ id }: { id: string }) => id === bookingId));
  console.log('PASS provider cards can be hidden after the visit date while booking history is preserved.');
}
