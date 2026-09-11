import {
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_LIFETIME_SEC,
} from '@txnet-backend/shared-core';

import { refreshCookieOptions, withRefreshCookie } from './refresh-cookie';

/**
 * One cookie, one options block, one lifetime (F-073, ADR-0036).
 *
 * Every route that mints a session writes this cookie, and until now two of
 * them built the options separately — `register.controller.ts` re-declared
 * `domain`, `secure`, `sameSite` and `maxAge` inline. The failure that follows
 * is silent and expensive: a cookie written with a different `domain` does not
 * overwrite the other one, so the browser ends up holding two `refresh_token`
 * cookies, sends whichever it likes, and the user lands in a session they did
 * not choose. Nothing is red at any point.
 *
 * These assertions are about the properties that cause that, not about the
 * values for their own sake.
 */

const ORIGINAL = { ...process.env };

function response() {
  const cookies: Array<[string, string, Record<string, unknown>]> = [];
  const cleared: Array<[string, Record<string, unknown>]> = [];
  return {
    cookies,
    cleared,
    cookie: (name: string, value: string, options: Record<string, unknown>) =>
      cookies.push([name, value, options]),
    clearCookie: (name: string, options: Record<string, unknown>) =>
      cleared.push([name, options]),
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL, DOMAIN_NAME: 'txnet.test' };
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('refreshCookieOptions', () => {
  it('is domain-wide, so one route cannot shadow another route’s cookie', () => {
    const options = refreshCookieOptions();
    // `.txnet.test` and `/` together are what make a second Set-Cookie from
    // any route overwrite the first rather than sit beside it.
    expect(options.domain).toBe('.txnet.test');
    expect(options.path).toBe('/');
  });

  it('keeps the token out of reach of a script and off plaintext by default', () => {
    const options = refreshCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.secure).toBe(true);
  });

  it('drops secure only when COOKIE_SECURE is exactly "false"', () => {
    // Local HTTP dev is the only reason this switch exists, so anything other
    // than a deliberate "false" must keep the cookie on TLS.
    process.env['COOKIE_SECURE'] = 'false';
    expect(refreshCookieOptions().secure).toBe(false);

    process.env['COOKIE_SECURE'] = 'no';
    expect(refreshCookieOptions().secure).toBe(true);
  });

  it('carries the one declared lifetime, converted to milliseconds', () => {
    // Express wants ms; every TTL in this platform is in seconds. The
    // conversion lives at this one call site precisely so a second route
    // cannot get it wrong in a different direction.
    expect(refreshCookieOptions().maxAge).toBe(REFRESH_TOKEN_LIFETIME_SEC * 1000);
  });
});

describe('withRefreshCookie', () => {
  it('moves the refresh token out of the body and into the cookie', () => {
    const res = response();
    const result = withRefreshCookie(res as never, {
      ok: true,
      data: { refreshToken: 'rt-1', accessToken: 'at-1' },
    });

    // The refresh token never travels in a body a script can read.
    expect(result.data.refreshToken).toBeUndefined();
    expect(result.data.accessToken).toBe('at-1');
    expect(res.cookies).toHaveLength(1);

    const [name, value, options] = res.cookies[0];
    expect(name).toBe(REFRESH_TOKEN_COOKIE);
    expect(value).toBe('rt-1');
    expect(options).toEqual(refreshCookieOptions());
  });

  it('writes nothing when the result carries no refresh token', () => {
    const res = response();
    withRefreshCookie(res as never, { ok: false, data: undefined });
    expect(res.cookies).toHaveLength(0);
  });
});
