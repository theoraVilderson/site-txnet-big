---
id: panel-web
layer: interface
status: active
version: 2
updated: 2026-09-05
---

# Contract — panel-web

A browser-facing Next.js app. It has no outbound API of its own beyond a few
route handlers that serve i18n. Screens/components live under
`site-pwa/src/app`.

## TL;DR

The browser calls `auth-service` directly and cross-origin, at the public
`NEXT_PUBLIC_API_ORIGIN` (`https://api.<domain>`) — there is no auth proxy hop
through this app. This is deliberate: an earlier same-origin proxy
(`site-pwa/src/app/api/auth/[...path]/route.ts`) traded reliability
(server-to-server, private network only) for the browser's cookie never being
storable cross-origin without `credentials: "include"` on every call, which is
what the direct-call approach fixes; the accepted cost is the public
DNS+Traefik+TLS round trip on every auth call (~0.5-2s, previously the source
of an intermittent 502 — see `dev-docker/docker-compose.main.yml`, `site-pwa`
service comment). `auth-service`'s CORS (`main.ts`) allows
`FRONTEND_ORIGIN=https://panel.<domain>` with `credentials: true`. Server
components still read translations from `locale-service` via the shared Node
client (server-side only, `serverExternalPackages`). Access token is held in
memory client-side (`lib/auth-api.ts`); the refresh token is the httpOnly
cookie set by `auth-service` with `Domain=.<DOMAIN_NAME>` and `path=/`, so it is
sent to this app's server too — which is what lets `src/proxy.ts` answer "is this
visitor signed in?" without any client-side probe (see the auth-screen guard
below).

## Route handlers (server)

| Method + path | Behaviour |
|---|---|
| `GET /api/i18n/[lang]/[ns]` | serves a namespace tree from the in-process locale store (boots + Watch) |
| `GET /api/i18n/meta` | available locales + metadata |
| `GET /api/i18n/version` | current locale snapshot version (for client cache-busting) |

## Client API surface

`lib/auth-api.ts` `authApi.*` — `loginPassword`, `otpChannels`,
`requestLoginOtp`, `verifyLoginOtp`, `register`, `verifyPhone`, `forgot`,
`verifyForgot`, `reset`, `botLinkStatus`, `refresh`, `logout`,
`captchaChallenge`, `captchaVerify`. All call
`${NEXT_PUBLIC_API_ORIGIN}/api/*` (cross-origin) with `credentials: "include"`;
on success the access token is stored in a module variable.

`loginPassword`, `requestLoginOtp`, `register` and `forgot` each take a
trailing `captchaToken`, sent as `X-Captcha-Token` — see auth-api's F-0201.
The `useCaptcha()` hook (`_hooks/useCaptcha.ts`) drives the
`NatureCaptchaUI` widget on the login/signup/forgot-password screens: it
requests a challenge on mount, exchanges a completed slide for a pass via
`captchaVerify`, and re-requests a challenge when that pass's 120s TTL
elapses or a gated call is rejected.

## OTP delivery method and messenger linking (F-0202, F-0203)

Which delivery methods exist is the **server's** answer, not this app's:
`useOtpChannels()` calls `GET /auth/otp/channels` and `OtpChannelPicker`
renders exactly what comes back (nothing, when there is only one). Never
hard-code sms/telegram/bale — a deployment can run with SMS switched off.

`requestLoginOtp` and `forgot` can answer `linkRequired: true` with a bot deep
link instead of sending a code. That is not an error: the chosen messenger is
not connected to the account yet. The screen shows `BotLinkStep`, the user
shares their contact with the bot, and `useBotLink()` polls
`POST /auth/bots/link/status` every 2.5s until `state: "linked"` — at which
point the code has already been sent *by the bot*, and the flow continues on
the code step. A client that treats `linkRequired` as "code sent" leaves the
user waiting for a code that will never arrive.

One-time codes are `OTP_LENGTH` (6) digits — `lib/otp.ts`. The API validates
that exact length, so the input must not use another.

## Auth-screen session guard (F-0101)

A signed-in visitor must never be shown the login or signup screen. The check
runs in `src/proxy.ts` (the Next 16 proxy, formerly `middleware.ts`), before the
screen renders — not in the browser. That is the whole trick: the refresh token
is httpOnly and unreadable by script, but on the server it is just a request
header, and it reaches `panel.<domain>` because auth-service sets it with a
`Domain` attribute (see auth-api `open-questions.md` — the contracts still claim
otherwise).

| request | what happens | cost |
|---|---|---|
| no `refresh_token` cookie | passes straight through | nothing — no request, no delay |
| cookie present, still live | 307 to `PANEL_HOME` before any HTML is sent | one server-to-server call |
| cookie present, dead | falls through to the form, cookie cleared | one server-to-server call, once |

`POST /api/auth/refresh` is the question asked, because it is the only route
that takes a refresh token: `ok: true` means the visitor is signed in, anything
else means they need to log in. auth-service's `Set-Cookie` headers are
forwarded to the browser verbatim, so the rotated token lands on success and the
dead one is cleared on failure — after which the visitor is on the no-cookie row
and pays nothing again.

**Fails open, always to the auth screen.** auth-service unreachable, a timeout
(4s), an unparseable body — every one of them shows the form. A signed-in user
seeing the login form is a slightly stale screen; a signed-out one redirected
into the panel would be a bug.

`AUTH_SERVICE_ORIGIN` keeps this hop inside `private_backend_network`. It exists
because the public origin used for browser calls would send it back out through
DNS + Traefik + TLS — the ~0.5-2s the TL;DR above accepts for the browser, but
paid before first byte here, which is exactly what this check exists to avoid.
It falls back to `NEXT_PUBLIC_API_ORIGIN` when unset (`next dev` outside
compose).

Every post-auth destination is `PANEL_HOME` from `lib/routes.ts` — `/`, the
panel root at `panel.<domain>`. Relative on purpose: each tenant is served on
its own white-label domain, so an absolute URL would pin them all to one host.
`forgot-password` is deliberately not guarded: resetting a password while
signed in elsewhere is legitimate.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| auth-api | every auth action, direct cross-origin call, incl. the captcha challenge/verify pair | auth screens error; SSR pages still render |
| i18n | translations (server-side gRPC client, `scope=frontend`) | boot blocks then fails fast (SSR i18n unavailable) |

## Config

`NEXT_PUBLIC_API_ORIGIN`, `AUTH_SERVICE_ORIGIN` (server-side only, see the
auth-screen guard below), `LOCALE_SERVICE_ADDR`, `LOCALE_SCOPE=frontend`,
`DEFAULT_LOCALE=fa`, cookies `NEXT_LOCALE` / `NEXT_THEME`. Themes:
`light` / `dark` / `ocean`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `src/app/api/auth/[...path]/route.ts`, `src/app/api/auth/register/route.ts` (same-origin proxy) | 2026-09-05 | removed | direct cross-origin call to `auth-service`, see TL;DR above |
| 5-digit OTP input | 2026-09-05 | removed | `OTP_LENGTH` (6) from `lib/otp.ts` — the API always required 6 |
| forgot-password ending on `/auth/login` | 2026-09-05 | removed | `auth-api` v5 returns a session with the reset, so the flow ends on `PANEL_HOME` |
