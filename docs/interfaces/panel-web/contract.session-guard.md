---
id: panel-web
layer: interface
status: active
version: 8
updated: 2026-09-09
---

# panel-web — the auth-screen session guard (F-0101)

Split out of [contract.md](contract.md) at 250 lines (§10). This is one
self-contained rule with one implementation file, `src/proxy.ts`.

## Auth-screen session guard (F-0101)

A signed-in visitor must never be shown the login or register screen. The check
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

`GET /api/auth/session` is the question asked. It answers
`{ok:true, data:{active}}` and changes nothing; `active: true` means the visitor
is signed in, anything else means they need to log in. auth-service's
`Set-Cookie` headers are still forwarded verbatim, so the clear of a dead token
reaches the browser — after which the visitor is on the no-cookie row and pays
nothing again.

**It must not be `/auth/refresh`** (ADR-0013). Refresh *rotates*: it revokes the
session it is asked about and mints a replacement. This handler runs on far more
requests than the visitor ever sees a response to — `config.matcher` covers every
non-static path, so RSC prefetches of `/auth/login`, redirects and in-flight
duplicates all reach it — and every one of those rotations returned the new token
in a `Set-Cookie` the browser might discard. The browser was then left holding a
revoked cookie that still looked present, and the panel's own `ensureSession()`
bounced the user to the login screen on the next page load. The rows it minted
are still identifiable in `identity.session` by `userAgent = node`.

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

## Naming the tenant, on the internal hop (F-066-r)

`AUTH_SERVICE_ORIGIN` reaches auth-service directly, which means the request
never passes Traefik — and auth-service resolves a request's tenant from the
host it was called on (ADR-0020), reading `X-Forwarded-Host` because that is
what Traefik forwards. Over the internal hop that host is the container's own
name, which matches no `tenant_domain` row. While a fallback tenant existed
this went unnoticed; F-066-d removed it, so an unresolved host became a neutral
404 and this guard silently stopped redirecting anyone. Login itself was never
affected — it goes to `api.<domain>`, which has a row.

So the proxy sets `X-Forwarded-Host` to the host of
`NEXT_PUBLIC_API_ORIGIN` — the public API host this deployment belongs to —
and only when it is actually using the internal origin. On the public origin
the real `Host` is already right, and a second answer that can disagree with
the URL is worth not having. Unset or unparseable: no header, and the guard
fails open to the form as it does for every other failure.

**A host, not a tenant id.** `X-Tenant-Id` is honoured only from a caller
holding the service token (`domains/tenant/contract.md`), and that token also
satisfies the captcha gate and moves the rate-limit subject off the IP — more
authority than a read-only session check should carry. A host is checked
against verified domains and grants nothing else.
