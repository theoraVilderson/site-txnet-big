---
id: auth-api
layer: interface
status: active
version: 18
updated: 2026-09-11
---

# auth-api — the refresh cookie

Split out of `contract.md` at the 250-line ceiling (§10). One topic, one
builder, one gate: `shared-core/src/lib/http/cookies.ts` declares the name and
the lifetime, `contracts/http/wire.json` is the language-neutral home, and
`refresh-cookie.spec.ts` plus a `contract.e2e.spec.ts` assertion hold the
service to both.

## Attributes

| attribute | value | why |
|---|---|---|
| `httpOnly` | always | no script on any subdomain can read the token |
| `path` | `/` | with `Domain`, this is what makes a second `Set-Cookie` overwrite the first rather than sit beside it |
| `Domain` | `.<DOMAIN_NAME>` | the cookie must reach `panel.<domain>`, where `panel-web`'s proxy reads it server-side to keep a signed-in visitor off the auth screens (F-0101). Narrowing it to `api.<domain>` breaks that check. Decided 2026-09-05 |
| `SameSite` | `Lax` | |
| `Secure` | set unless `COOKIE_SECURE=false` | the switch exists for local HTTP dev only. Anything other than a deliberate `"false"` keeps the cookie on TLS |
| `Max-Age` | 30 days | the same value as the refresh token's own TTL — see below |

## Every route that mints a session writes the identical cookie

Normative, not an implementation note. Two routes writing the same name with a
different `Domain` do not overwrite each other: the browser holds two
`refresh_token` cookies, sends whichever it likes, and the user lands in a
session they did not choose. Nothing is red at any point.

`register/verify-phone` built its own attribute block until F-073 — exactly
that shape, and identical to the shared one only by coincidence. The single
builder is `common/http/refresh-cookie.ts`, over the name and lifetime declared
in `contracts/http/wire.json` (ADR-0036, C-04).

The e2e assertion for this is an **equality** between the register route's
attribute set and the login route's. Checking each against a literal would stay
green with two copies that agree today and drift tomorrow, which is the whole
failure.

## The cookie's lifetime and the token's are one value

`REFRESH_TOKEN_LIFETIME_SEC`. A cookie that outlives its token is a browser
that believes it is signed in and is refused on every refresh; a token that
outlives its cookie is a live session the browser has quietly thrown away.
They were written separately in three places — two in milliseconds, one in
seconds — before F-073.

## `panel-web` is the one consumer that still hand-copies the name

`site-pwa/src/proxy.ts` spells `refresh_token` itself. It is not in the Nx
workspace and has no path to `shared-core`, so C-04's check skips it and a
rename here would not fail there. Open, with a date:
`docs/platform/forward-auth/open-questions.md`.
