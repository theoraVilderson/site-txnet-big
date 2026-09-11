import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALL_WIRE_HEADERS,
  ALWAYS_SET_IDENTITY_HEADERS,
  AUTH_ANONYMOUS_HEADER,
  FORWARDED_FOR_HEADER,
  IMPERSONATION_HEADERS,
  IdentityHeaders,
  RequestHeaders,
  headerValue,
} from './headers';
import {
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_LIFETIME_SEC,
} from './cookies';

/**
 * The TypeScript half of the wire contract (ADR-0036, C-04).
 *
 * `contracts/http/wire.json` is hand-written and language-neutral; this spec
 * asserts that the constants in `headers.ts` and `cookies.ts` are exactly it,
 * and `auth-handler/internal/api/handlers/headers_contract_test.go` asserts
 * the same of the Go side. Neither side imports the other — that is the whole
 * problem — so the fixture plus two tests is what an import would have been.
 *
 * A failure here means one of two things and they want opposite fixes: either
 * somebody renamed a header in code and forgot the fixture (fix the code, or
 * update the fixture *and* the Traefik lists and the Go consts together), or
 * somebody edited the fixture on purpose and this is the first of several red
 * tests telling them where the other spellings live. That is the intended
 * behaviour, not a nuisance.
 */

const FIXTURE = join(__dirname, '../../../../../contracts/http/wire.json');

interface WireFixture {
  identityHeaders: Record<string, string>;
  alwaysSetIdentityHeaders: string[];
  impersonationHeaders: string[];
  gateHeaders: Record<string, string>;
  proxyHeaders: Record<string, string>;
  requestHeaders: Record<string, string>;
  cookies: Record<string, string>;
  cookieLifetimesSec: Record<string, number | string>;
}

function load(): WireFixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as WireFixture;
}

/** The fixture carries a `note` beside the real entries; it is not a name. */
function names(block: Record<string, string>): Record<string, string> {
  const { note: _note, ...rest } = block;
  return rest;
}

describe('contracts/http/wire.json', () => {
  it('declares exactly the identity headers headers.ts exports', () => {
    expect(names(load().identityHeaders)).toEqual({ ...IdentityHeaders });
  });

  it('agrees on which identity headers are always set', () => {
    expect(load().alwaysSetIdentityHeaders).toEqual([
      ...ALWAYS_SET_IDENTITY_HEADERS,
    ]);
    expect(load().impersonationHeaders).toEqual([...IMPERSONATION_HEADERS]);
  });

  it('declares the anonymous marker outside the identity set', () => {
    const fixture = load();
    expect(fixture.gateHeaders['anonymous']).toBe(AUTH_ANONYMOUS_HEADER);
    // It is evidence the gate ran, never an identity. A consumer that read it
    // as one would treat a signed-out caller as a signed-in one with no id.
    expect(fixture.alwaysSetIdentityHeaders).not.toContain(
      AUTH_ANONYMOUS_HEADER,
    );
  });

  it('declares exactly the request headers headers.ts exports', () => {
    expect(names(load().requestHeaders)).toEqual({ ...RequestHeaders });
  });

  it('declares the proxy header outside the contract set', () => {
    const fixture = load();
    expect(fixture.proxyHeaders['forwardedFor']).toBe(FORWARDED_FOR_HEADER);
    // Traefik sets it and anything bypassing Traefik can forge it, so it is
    // not identity and must not be in the set a consumer trusts.
    expect(fixture.alwaysSetIdentityHeaders).not.toContain(FORWARDED_FOR_HEADER);
  });

  it('declares the refresh cookie name and its one lifetime', () => {
    const fixture = load();
    expect(fixture.cookies['refreshToken']).toBe(REFRESH_TOKEN_COOKIE);
    expect(fixture.cookieLifetimesSec['refreshToken']).toBe(
      REFRESH_TOKEN_LIFETIME_SEC,
    );
  });

  it('names nothing twice, in any casing', () => {
    // HTTP header names are case-insensitive, so `x-tenant-id` and
    // `X-Tenant-Id` would be one name declared twice — the exact drift this
    // fixture exists to stop. Lowercasing before the comparison is what makes
    // the test able to see it.
    const lowered = ALL_WIRE_HEADERS.map((h) => h.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });
});

describe('headerValue', () => {
  it('reads a header declared in canonical case out of a lowercased bag', () => {
    const headers = { 'x-user-id': 'user-1' };
    expect(headerValue(headers, IdentityHeaders.userId)).toBe('user-1');
  });

  it('treats an empty or whitespace-only header as absent', () => {
    // A blank X-Tenant-Id must not become a request scoped to tenant "".
    expect(headerValue({ 'x-tenant-id': '   ' }, IdentityHeaders.tenantId)).toBe(
      undefined,
    );
    expect(headerValue({}, IdentityHeaders.tenantId)).toBe(undefined);
  });

  it('refuses a header that arrived more than once', () => {
    // Picking one of them is picking for the attacker. `captcha.guard.ts` has
    // refused a repeated token since it was written; the rule lives here now.
    const headers = { 'x-captcha-token': ['tok-1', 'tok-2'] };
    expect(headerValue(headers, RequestHeaders.captchaToken)).toBe(undefined);
  });

  it('accepts a single-entry array, which is the same thing as a string', () => {
    const headers = { 'x-captcha-token': ['tok-1'] };
    expect(headerValue(headers, RequestHeaders.captchaToken)).toBe('tok-1');
  });

  it('reads the tenant header a caller sent in lowercase', () => {
    // One name, two directions: bot-service sends it, auth-handler writes it.
    expect(
      headerValue({ 'x-tenant-id': 'tenant-1' }, IdentityHeaders.tenantId),
    ).toBe('tenant-1');
  });
});
