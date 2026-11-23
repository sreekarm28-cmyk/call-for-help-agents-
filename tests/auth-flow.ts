import assert from 'node:assert/strict';
import type { FlowContext } from './flow-helpers.js';

export async function testAuthFlow(context: FlowContext) {
  const { post } = context;
  for (let attempt = 0; attempt < 11; attempt++) {
    const login = await post('/api/auth/login', {
      email: 'missing-account@example.test', password: 'provider-flow-test-password',
    });
    assert.equal(login.status, attempt < 10 ? 401 : 429);
    if (attempt === 10) assert.ok(Number(login.headers.get('Retry-After')) > 0);
    await login.text();
  }
  console.log('PASS sign-in limit and Retry-After');

}
