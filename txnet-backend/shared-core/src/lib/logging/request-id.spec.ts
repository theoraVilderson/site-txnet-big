import { IdentityHeaders, RequestHeaders } from '../http/headers';
import { RequestIdMiddleware } from './request-id.middleware';
import { acceptRequestId, currentRequestId, currentRequestUserId, runWithRequestId } from './request-scope';

/**
 * H13 (`platform/hosting/contract.md`): a caller's `X-Request-Id` is kept only
 * when it is 8–128 characters of `[A-Za-z0-9-]`; anything else — a log
 * injection attempt, a 4 KB header — is replaced by a fresh UUID v4, so the
 * id a log line carries is always one a Loki query can match.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('acceptRequestId', () => {
  it('keeps an id that fits the rule', () => {
    expect(acceptRequestId('abcd-1234')).toBe('abcd-1234');
    expect(acceptRequestId('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('replaces an absent, short, long or unsafe id with a UUID v4', () => {
    for (const raw of [undefined, '', 'short', 'a'.repeat(129), 'abc def ghi', 'id\n{"level":"ERROR"}']) {
      expect(acceptRequestId(raw)).toMatch(UUID_V4);
    }
  });
});

describe('RequestIdMiddleware', () => {
  function run(headers: Record<string, string>) {
    const set: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => (set[name] = value) };
    let seen: string | undefined;
    let user: string | undefined;
    new RequestIdMiddleware().use({ headers }, res, () => {
      seen = currentRequestId();
      user = currentRequestUserId();
    });
    return { seen, set, user };
  }

  it('puts the caller\'s id in scope for the rest of the request and on the response', () => {
    const { seen, set } = run({ [RequestHeaders.requestId]: 'trace-0001' });
    expect(seen).toBe('trace-0001');
    expect(set[RequestHeaders.requestId]).toBe('trace-0001');
  });

  it('mints one when the caller sent none, and answers with that one', () => {
    const { seen, set } = run({});
    expect(seen).toMatch(UUID_V4);
    expect(set[RequestHeaders.requestId]).toBe(seen);
  });

  it('knows the user the gate identified, and nobody when it identified nobody', () => {
    expect(run({ [IdentityHeaders.userId.toLowerCase()]: 'user-1' }).user).toBe('user-1');
    expect(run({}).user).toBeUndefined();
  });

  it('has no id outside a request', () => {
    expect(currentRequestId()).toBeUndefined();
    expect(runWithRequestId('trace-0002', () => currentRequestId())).toBe('trace-0002');
  });
});
