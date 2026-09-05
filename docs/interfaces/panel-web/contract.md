---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-09-04
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
cookie set by `auth-service`, scoped to `api.<domain>` (no `Domain` attribute).

## Route handlers (server)

| Method + path | Behaviour |
|---|---|
| `GET /api/i18n/[lang]/[ns]` | serves a namespace tree from the in-process locale store (boots + Watch) |
| `GET /api/i18n/meta` | available locales + metadata |
| `GET /api/i18n/version` | current locale snapshot version (for client cache-busting) |

## Client API surface

`lib/auth-api.ts` `authApi.*` — `loginPassword`, `requestLoginOtp`,
`verifyLoginOtp`, `register`, `verifyPhone`, `forgot`, `verifyForgot`, `reset`,
`refresh`, `logout`, `captchaChallenge`, `captchaVerify`. All call
`${NEXT_PUBLIC_API_ORIGIN}/api/*` (cross-origin) with `credentials: "include"`;
on success the access token is stored in a module variable.

`loginPassword`, `requestLoginOtp`, `register` and `forgot` each take a
trailing `captchaToken`, sent as `X-Captcha-Token` — see auth-api's F-0201.
The `useCaptcha()` hook (`_hooks/useCaptcha.ts`) drives the
`NatureCaptchaUI` widget on the login/signup/forgot-password screens: it
requests a challenge on mount, exchanges a completed slide for a pass via
`captchaVerify`, and re-requests a challenge when that pass's 120s TTL
elapses or a gated call is rejected.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| auth-api | every auth action, direct cross-origin call, incl. the captcha challenge/verify pair | auth screens error; SSR pages still render |
| i18n | translations (server-side gRPC client, `scope=frontend`) | boot blocks then fails fast (SSR i18n unavailable) |

## Config

`NEXT_PUBLIC_API_ORIGIN`, `LOCALE_SERVICE_ADDR`, `LOCALE_SCOPE=frontend`,
`DEFAULT_LOCALE=fa`, cookies `NEXT_LOCALE` / `NEXT_THEME`. Themes:
`light` / `dark` / `ocean`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `src/proxy.ts` middleware | 2026-09-04 (no-op stub) | when real middleware is needed | — |
