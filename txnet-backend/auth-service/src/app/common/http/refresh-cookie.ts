import {
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_LIFETIME_SEC,
} from '@txnet-backend/shared-core';
import { Response } from 'express';

/**
 * The one definition of the `refresh_token` cookie.
 *
 * It is shared rather than repeated per controller because two controllers now
 * mint sessions — `auth` (login, register, reset) and `account-switch`
 * (F-0207) — and a cookie written with a different `domain` or `path` by one of
 * them would not overwrite the other's. The browser would then hold two
 * `refresh_token` cookies, send whichever it likes, and the user would land
 * back on the account they just switched away from.
 *
 * **Host-only** (F-066-u, ADR-0060): no `domain`, so the cookie belongs to the
 * exact host the panel was loaded from. The panel calls `/api/auth` on its own
 * domain, so the host that sets the cookie is the host that reads it — the
 * platform's panel, and every reseller's. A `Domain=.<DOMAIN_NAME>` cookie is
 * refused outright by a browser on a reseller's own domain, and under the
 * platform's domain it would reach every reseller's `<slug>.<domain>` too.
 */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax' as const,
    path: '/',
    // The one lifetime, shared with the token the cookie carries
    // (`shared-core/src/lib/http/cookies.ts`, C-04). Express wants
    // milliseconds and every TTL in this platform is in seconds, so the
    // conversion is here, at the one call site that needs it.
    maxAge: REFRESH_TOKEN_LIFETIME_SEC * 1000,
  };
}

/**
 * Expires the domain-wide `refresh_token` every session before ADR-0060 was
 * written as (`Domain=.<DOMAIN_NAME>`).
 *
 * A browser that still holds it and is then given the host-only one holds
 * **two** — a different `Domain` is a different cookie — and sends the older
 * first. That one names the session the write just rotated away, so the next
 * refresh would sign the user out. Every write and every clear therefore
 * expires the old one in the same response. On a host outside `DOMAIN_NAME`
 * the browser ignores this `Set-Cookie`, which is the harmless answer.
 */
export function expireLegacyRefreshCookie(res: Response): void {
  const domainName = process.env.DOMAIN_NAME;
  if (!domainName) return;
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_TOKEN_COOKIE, { ...options, domain: `.${domainName}` });
}

/**
 * Writes the refresh cookie, and retires the domain-wide one it replaces.
 *
 * The real cookie's `Set-Cookie` goes first. A browser keys the two apart by
 * `Domain` and ignores the order, but a client that reads the first
 * `refresh_token` line it finds — the e2e cookie jar does — then reads this one.
 */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, refreshCookieOptions());
  expireLegacyRefreshCookie(res);
}

/** Clears the refresh cookie, the domain-wide one included — in that order. */
export function clearRefreshCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_TOKEN_COOKIE, options);
  expireLegacyRefreshCookie(res);
}

/**
 * Moves `data.refreshToken` out of the response body and into the cookie.
 *
 * The refresh token never travels in a body a script can read: `auth-api`'s
 * contract says `tokens` = `{accessToken, expiresIn}`, and the refresh half is
 * httpOnly-cookie-only.
 */
export function withRefreshCookie<T extends { ok?: boolean; data?: any }>(
  res: Response,
  result: T,
): T {
  if (result?.ok && result?.data?.refreshToken) {
    setRefreshCookie(res, result.data.refreshToken);
    const { refreshToken, ...rest } = result.data;
    result.data = rest;
  }
  return result;
}
