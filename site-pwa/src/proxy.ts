// Next 16 middleware (`proxy.ts`, formerly `middleware.ts`).
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_REGISTER, PANEL_HOME } from "@/lib/routes";

/**
 * Auth screens a signed-in visitor has no business seeing. `forgot-password` is
 * deliberately absent: resetting a password while signed in elsewhere is
 * legitimate.
 */
const GUARDED_PATHS = ["/auth/login", AUTH_REGISTER];

/**
 * The session cookie this middleware reads. Exported so `proxy.test.ts` asserts
 * against the same string the code uses — auth-service owns the name
 * (`common/http/refresh-cookie.ts`) and a rename there has to fail here.
 *
 * **It is still a hand-copied string, and nothing enforces that.** Every other
 * spelling in the platform now imports it from
 * `shared-core/src/lib/http/cookies.ts` (ADR-0036, C-04). This app cannot: it
 * is not in the Nx workspace and has no path to that library, so C-04's check
 * skips it. Whether to vendor a tarball the way `@txnet/locale-client` already
 * is, is open — `docs/platform/forward-auth/open-questions.md`, 2026-09-11.
 */
export const REFRESH_COOKIE = "refresh_token";

/**
 * The screen used to live at `/auth/signup`. It is `register` everywhere else
 * in the platform — auth-api's `POST /auth/register`, the bot's `RegisterFlow`,
 * coinsite's `/register` — so the panel moved to that name too.
 *
 * Links to the old path exist where this repo cannot edit them: bot deep links
 * already sent, bookmarks, anything printed. `308` and not `307` because the
 * move is permanent and a browser may cache it; unlike `301` it is also
 * required to keep the method, which matters the day this path takes a POST.
 */
const RENAMED_PATH = "/auth/signup";

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

/**
 * The host this deployment's API is reached at publicly, or `null`.
 *
 * auth-service resolves a request's tenant from the host it was called on
 * (ADR-0020), and `req.hostname` there reads `X-Forwarded-Host` because that is
 * what Traefik forwards. The hop below skips Traefik on purpose, so without
 * this the host auth-service sees is the container name — which matches no
 * `tenant_domain` row, and since F-066-d removed the fallback tenant an
 * unresolved host is a neutral 404. The visitor stayed on the login form.
 *
 * So the panel states the host it belongs to. It states a *host*, not a tenant
 * id: the id would need the service token `bot-service` carries, and that token
 * also satisfies the captcha gate and moves the rate-limit subject — more than
 * a session check should hold. A host is checked against verified domains and
 * grants nothing else (`domains/tenant/contract.md`).
 */
function publicApiHost(): string | null {
  const origin = process.env.NEXT_PUBLIC_API_ORIGIN;
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
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
 * - cookie -> ask auth-service whether it still means anything. `GET
 *   /auth/session` answers exactly that and changes nothing. `active` ->
 *   redirect; anything else -> the token is dead, the visitor does need to log
 *   in, show the form.
 *
 * It must be a *read-only* question, which is why it is not `/auth/refresh`.
 * Refreshing rotates — it revokes the caller's session and mints a new one —
 * and this handler runs on far more requests than the visitor ever sees a
 * response to: `config.matcher` covers every non-static path, so RSC prefetches
 * of `/auth/login`, redirects, and concurrent requests all reach it. Every one
 * of those rotated the session and returned the replacement in a `Set-Cookie`
 * the browser might never apply, leaving it holding a revoked token that still
 * looks present in devtools. The next real refresh then signed the user out —
 * which is what the panel's bounce back to the login screen actually was.
 *
 * A dead cookie is still cleared, by auth-service, and that clear is handed
 * back to the browser here — so the next visit takes the no-cookie path.
 *
 * Every failure mode ends at the auth screen: auth-service unreachable, a
 * timeout, an unparseable body. The worst case is that a signed-in user sees
 * the login form, never that a signed-out one is redirected into the panel.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Before the session check, not after: this is a rename, not an auth
  // question. A signed-in visitor is redirected here and then guarded on
  // `/auth/register`, so asking auth-service first would be a wasted round
  // trip on every hit of a dead path.
  if (pathname === RENAMED_PATH || pathname.startsWith(`${RENAMED_PATH}/`)) {
    const target = request.nextUrl.clone();
    target.pathname = AUTH_REGISTER + pathname.slice(RENAMED_PATH.length);
    return NextResponse.redirect(target, 308);
  }

  if (!isGuarded(pathname)) return null;

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return null;

  const origin = authServiceOrigin();
  const headers: Record<string, string> = {
    cookie: `${REFRESH_COOKIE}=${refreshToken}`,
  };

  // Only on the internal hop. When the call already goes to the public origin
  // the real `Host` is the right one, and a second answer that can disagree
  // with the URL is worth avoiding.
  const apiHost = publicApiHost();
  if (apiHost && origin !== process.env.NEXT_PUBLIC_API_ORIGIN) {
    headers["x-forwarded-host"] = apiHost;
  }

  const upstream = await fetch(`${origin}/api/auth/session`, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  }).catch(() => null);

  if (!upstream) return null;

  // auth-service answers business failures inside a 200 envelope
  // (`{ ok: false, msg }`), so the status alone does not settle it.
  const body = await upstream.json().catch(() => null);
  const isSignedIn =
    upstream.ok && body?.ok === true && body?.data?.active === true;

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
