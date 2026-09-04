---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-09-04
---

# Contract — panel-web

A browser-facing Next.js app. It has no outbound API of its own beyond a few
route handlers that proxy or serve i18n. Screens/components live under
`site-pwa/src/app`.

## TL;DR

Server components + route handlers proxy the browser to `auth-service`
(`AUTH_API_ORIGIN`, default `https://api.txnet.cyou`) and read translations from
`locale-service` via the shared Node client (server-side only,
`serverExternalPackages`). Access token is held in memory client-side
(`lib/auth-api.ts`); the refresh token is the httpOnly cookie set by
`auth-service`.

## Route handlers (server)

| Method + path | Behaviour |
|---|---|
| `ALL /api/auth/[...path]` | transparent proxy to `${AUTH_API_ORIGIN}/api/auth/<path>` (strips `host`/`origin`, forwards cookies) |
| `POST /api/auth/register` | dedicated proxy to `${AUTH_API_ORIGIN}/api/auth/register` |
| `GET /api/i18n/[lang]/[ns]` | serves a namespace tree from the in-process locale store (boots + Watch) |
| `GET /api/i18n/meta` | available locales + metadata |
| `GET /api/i18n/version` | current locale snapshot version (for client cache-busting) |

## Client API surface

`lib/auth-api.ts` `authApi.*` — `loginPassword`, `requestLoginOtp`,
`verifyLoginOtp`, `register`, `verifyPhone`, `forgot`, `verifyForgot`, `reset`,
`refresh`, `logout`. All call `/api/*` (same origin) with `credentials:
"include"`; on success the access token is stored in a module variable.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| auth-api | every auth action (via the `/api/auth` proxy) | auth screens error; SSR pages still render |
| i18n | translations (server-side gRPC client, `scope=frontend`) | boot blocks then fails fast (SSR i18n unavailable) |

## Config

`AUTH_API_ORIGIN`, `LOCALE_SERVICE_ADDR`, `LOCALE_SCOPE=frontend`,
`DEFAULT_LOCALE=fa`, cookies `NEXT_LOCALE` / `NEXT_THEME`. Themes:
`light` / `dark` / `ocean`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `src/proxy.ts` middleware | 2026-09-04 (no-op stub) | when real middleware is needed | — |
