import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signZohoState, verifyZohoState } from './zoho-oauth-state.js';

const SECRET = 'a-test-secret-that-is-long-enough-1234567890';
const BRAND_ID = '11111111-1111-1111-1111-111111111111';

describe('Zoho OAuth state', () => {
  it('round-trips the brand id through sign and verify', () => {
    const state = signZohoState(BRAND_ID, SECRET);
    expect(verifyZohoState(state, SECRET)).toEqual({ brandId: BRAND_ID });
  });

  it('rejects a state signed with a different secret', () => {
    const state = signZohoState(BRAND_ID, SECRET);
    expect(verifyZohoState(state, 'a-completely-different-secret-value')).toBeNull();
  });

  it('rejects a tampered payload even with a structurally valid signature format', () => {
    const state = signZohoState(BRAND_ID, SECRET);
    const [, signature] = state.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ brandId: '22222222-2222-2222-2222-222222222222', iat: Date.now() }),
      'utf8',
    ).toString('base64url');
    expect(verifyZohoState(`${forgedPayload}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects a malformed state string instead of throwing', () => {
    expect(verifyZohoState('not-a-valid-state', SECRET)).toBeNull();
    expect(verifyZohoState('', SECRET)).toBeNull();
  });

  it('rejects a state older than the allowed window', () => {
    // Construct one directly with a backdated iat, bypassing signZohoState's
    // use of Date.now().
    const stalePayload = { brandId: BRAND_ID, iat: Date.now() - 11 * 60 * 1000 };
    const encoded = Buffer.from(JSON.stringify(stalePayload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
    expect(verifyZohoState(`${encoded}.${signature}`, SECRET)).toBeNull();
  });
});
