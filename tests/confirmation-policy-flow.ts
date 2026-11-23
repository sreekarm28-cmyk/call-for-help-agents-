import assert from 'node:assert/strict';
import { waitFor, type FlowContext } from './flow-helpers.js';

type Fixture = { requestId: string; bookingId: string; callId: string; offers: string[] };

export async function testConfirmationPolicyFlow(context: FlowContext, setup: () => Promise<Fixture>) {
  const { database, schema, baseUrl, env } = context;
  const t = (name: string) => `"${schema}".${name}`;
  const headers = { Authorization: `Bearer ${env.CALL_TRANSCRIPT_TOKEN}`, 'Content-Type': 'application/json' };
  const internal = (path: string, body: object) => fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const fixture = await setup();
  let id = fixture.callId;
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: id })).status, 200);
    assert.equal((await internal(`/api/internal/call-attempts/${id}/outcome`, { status: attempt === 1 ? 'rejected' : 'no_answer' })).status, 200);
    if (attempt < 5) {
      const next = await waitFor('next bounded confirmation attempt', async () => {
        const { rows: [call] } = await database.query<{ id: string; confirmation_role: string; delayed: boolean }>(
          `SELECT c.id, b.confirmation_role, c.available_at > clock_timestamp() AS delayed
           FROM ${t('bookings')} b JOIN ${t('call_attempts')} c ON c.id = b.confirmation_call_attempt_id
           WHERE b.request_id=$1 AND b.status='awaiting_provider_confirmation' AND c.status='queued' AND c.id<>$2`,
          [fixture.requestId, id],
        );
        return call;
      });
      assert.equal(next.confirmation_role, attempt < 3 ? 'primary' : 'backup');
      if (attempt !== 3) {
        assert.equal(next.delayed, true);
        assert.equal((await internal('/api/internal/test-calls/claim', { callAttemptId: next.id })).status, 204);
      }
      await database.query(`UPDATE ${t('call_attempts')} SET available_at=clock_timestamp() WHERE id=$1`, [next.id]);
      id = next.id;
    }
  }
  await waitFor('all attempts exhausted', async () => {
    const { rows: [row] } = await database.query(
      `SELECT count(*)::int AS active FROM ${t('bookings')} WHERE request_id=$1 AND status='awaiting_provider_confirmation'`, [fixture.requestId],
    );
    return row.active === 0 ? true : undefined;
  });
  const { rows } = await database.query(
    `SELECT b.confirmation_role, count(*)::int AS attempts FROM ${t('call_attempts')} c
     JOIN ${t('bookings')} b ON b.id=c.confirmation_booking_id WHERE b.request_id=$1
     GROUP BY b.confirmation_role ORDER BY b.confirmation_role`, [fixture.requestId],
  );
  assert.deepEqual(rows, [{ confirmation_role: 'backup', attempts: 2 }, { confirmation_role: 'primary', attempts: 3 }]);
  assert.equal((await database.query(
    `SELECT id FROM ${t('call_attempts')} WHERE request_id=$1 AND status IN ('queued','calling')`, [fixture.requestId],
  )).rowCount, 0);
  console.log('PASS unanswered calls use exactly three primary attempts and two backup attempts, with delayed retries and no sixth call.');
}
