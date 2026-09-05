// Next 16 middleware (`proxy.ts`, formerly `middleware.ts`).
import { NextResponse, type NextRequest } from "next/server";
import { PANEL_HOME } from "@/lib/routes";

/**
 * Auth screens a signed-in visitor has no business seeing. `forgot-password` is
 * deliberately absent: resetting a password while signed in elsewhere is
 * legitimate.
 */
const GUARDED_PATHS = ["/auth/login", "/auth/signup"];

const REFRESH_COOKIE = "refresh_token";

/**
 * auth-service, server-to-server. `AUTH_SERVICE_ORIGIN` keeps this hop inside
 * `private_backend_network` (`http://auth-service:${AUTH_PORT}`), which is the
 * whole point of doing the check here — the public origin would send it back
 * out through DNS + Traefik + TLS, the ~0.5-2s the panel-web contract's TL;DR
 * budgets for browser calls. ASSUMED(2026-09-05): falling back to the public
 * origin is correct when the internal one is unset (local `next dev` outside
 * compose); see open-questions.
 */
function authServiceOrigin(): string {
  return (
    process.env.AUTH_SERVICE_ORIGIN ?? process.env.NEXT_PUBLIC_API_ORIGIN ?? ""
  );
}

function isGuarded(pathname: string): boolean {
  return GUARDED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * Sends an already-signed-in visitor to the panel home before the auth screen
 * renders at all (F-0101).
 *
 * The refresh token is httpOnly, so the browser can never inspect it — but this
 * runs on the server, where the cookie is just a request header. So:
 *
 * - no cookie -> a first-time visitor. Pass straight through: no request, no
 *   delay, the form exactly as before.
 * - cookie -> ask auth-service whether it still means anything. `/auth/refresh`
 *   is the one route that takes the refresh token, so it is the "does this user
 *   need to log in?" question. `ok` -> redirect; anything else -> the token is
 *   dead, the visitor does need to log in, show the form.
 *
 * Whatever auth-service decides about the cookie is handed straight back to the
 * browser: the rotated token on success, the clear on failure. So a dead token
 * is gone after this one request and the next visit takes the no-cookie path.
 *
 * Every failure mode ends at the auth screen: auth-service unreachable, a
 * timeout, an unparseable body. The worst case is that a signed-in user sees
 * the login form, never that a signed-out one is redirected into the panel.
 */
export async function proxy(request: NextRequest) {
  if (!isGuarded(request.nextUrl.pathname)) return null;

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return null;

  const upstream = await fetch(`${authServiceOrigin()}/api/auth/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${REFRESH_COOKIE}=${refreshToken}`,
    },
    body: "{}",
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  }).catch(() => null);

  if (!upstream) return null;

  // auth-service answers business failures inside a 200 envelope
  // (`{ ok: false, msg }`), so the status alone does not settle it.
  const body = await upstream.json().catch(() => null);
  const isSignedIn = upstream.ok && body?.ok === true;

  const response = isSignedIn
    ? NextResponse.redirect(new URL(PANEL_HOME, request.url))
    : NextResponse.next();

  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
