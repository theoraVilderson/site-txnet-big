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
 */
export function refreshCookieOptions() {
  const domainName = process.env.DOMAIN_NAME!;

  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax' as const,
    // Domain-wide on purpose: the cookie has to reach `panel.<domain>`, where
    // panel-web's proxy reads it server-side (F-0101).
    path: '/',
    domain: `.${domainName}`,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
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
    res.cookie('refresh_token', result.data.refreshToken, refreshCookieOptions());
    const { refreshToken, ...rest } = result.data;
    result.data = rest;
  }
  return result;
}
