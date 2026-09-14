import { createHmac } from 'node:crypto';

import { RESULT_TOKEN_TTL_SEC, signResultToken } from './payment-result-token';

/**
 * The result page used to believe its query string: `/payment/success?ref=X`
 * typed by hand showed a paid top-up that never happened. The callback now
 * hands the browser one signed token instead, and the panel shows nothing it
 * cannot verify (`panel-web/contract.payment-result.md`).
 */
const SECRET = 's'.repeat(32);
const NOW = 1_800_000_000_000;

function decode(token: string) {
  const [body, mac] = token.split('.');
  return { body, mac, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) };
}

describe('signResultToken', () => {
  it('carries a success, its reference and the already flag, with an expiry', () => {
    const token = signResultToken(
      { kind: 'success', referenceId: 'A123', alreadyPaid: true },
      SECRET,
      NOW,
    );
    expect(decode(token).payload).toEqual({
      k: 's',
      r: 'A123',
      a: 1,
      e: Math.floor(NOW / 1000) + RESULT_TOKEN_TTL_SEC,
    });
  });

  it('carries a failure code and nothing else', () => {
    const { payload } = decode(signResultToken({ kind: 'failed', code: 'SYSTEM_ERROR' }, SECRET, NOW));
    expect(payload).toEqual({ k: 'f', c: 'SYSTEM_ERROR', e: Math.floor(NOW / 1000) + RESULT_TOKEN_TTL_SEC });
  });

  it('carries a verifying payment by its id only (F-093-l)', () => {
    const { payload } = decode(signResultToken({ kind: 'verifying', paymentId: 'p-1' }, SECRET, NOW));
    expect(payload).toEqual({ k: 'v', p: 'p-1', e: Math.floor(NOW / 1000) + RESULT_TOKEN_TTL_SEC });
  });

  it('is an HMAC-SHA256 of the body under the shared secret', () => {
    const { body, mac } = decode(
      signResultToken({ kind: 'success', referenceId: null, alreadyPaid: false }, SECRET, NOW),
    );
    expect(mac).toBe(createHmac('sha256', SECRET).update(body).digest('base64url'));
  });

  it('refuses to sign with no secret, rather than sign with an empty one', () => {
    expect(() => signResultToken({ kind: 'failed', code: 'SYSTEM_ERROR' }, '', NOW)).toThrow();
  });
});
