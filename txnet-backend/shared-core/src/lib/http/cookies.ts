/**
 * The declared home of every cookie name that crosses the browser boundary
 * (ADR-0036, C-04), pinned to `contracts/http/wire.json` by
 * `wire.contract.spec.ts`.
 *
 * Only the **name** lives here. The options block and the lifetime are one
 * decision each and belong with the code that sets the cookie — see F-073 and
 * `auth-service/src/app/common/http/refresh-cookie.ts`.
 */

/**
 * The httpOnly cookie carrying the refresh token.
 *
 * It was spelled by hand in three applications and in the panel's proxy, which
 * is more places than a name can be renamed in one go. The failure that
 * follows is not a compile error anywhere: a browser ends up holding two
 * differently-named refresh cookies, sends whichever it likes, and the user
 * lands in the wrong session.
 */
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * How long the refresh cookie and the refresh token it carries both live.
 *
 * **One number, because they are one lifetime.** The cookie's `Max-Age` and
 * the session's TTL were written separately — `refresh-cookie.ts` in
 * milliseconds, `session.service.ts` in seconds, `register.controller.ts` in
 * milliseconds again — and the pair only behaves if they agree. A cookie that
 * outlives its token means a browser that believes it is signed in and is
 * refused on every refresh; a token that outlives its cookie means a live
 * session the browser has quietly thrown away.
 *
 * Seconds, because that is what `Max-Age` and every TTL in this platform are
 * in. The one place that needs milliseconds says so at the call site.
 */
export const REFRESH_TOKEN_LIFETIME_SEC = 30 * 24 * 60 * 60;
