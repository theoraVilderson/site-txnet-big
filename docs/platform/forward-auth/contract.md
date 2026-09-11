---
id: forward-auth
layer: platform
status: active
version: 3
updated: 2026-09-11
---

# Contract — forward-auth

A single Go binary behind Traefik's `forwardauth` middleware. See ADR-0004.

## TL;DR

Traefik sends every request on a protected router to `GET /validate`. On 2xx the
request proceeds upstream **with** the identity headers; any non-2xx blocks it.
`auth-handler` also strips client-supplied identity headers via a separate
Traefik middleware (`strip-fake-headers`).

## Endpoints

| Method + path | Behaviour |
|---|---|
| `GET /validate` | the access JWT (`Authorization: Bearer <jwt>`, or a WebSocket upgrade's subprotocol — see below) -> validate signature (HMAC-SHA256, always HS256) + `exp` + required claims -> check Redis key `<prefix>session:<sessionId>` exists -> if a policy file is loaded, check every claimed permission is granted to the token's `roleName`, matched exactly against the file's role keys (ADR-0037) -> set identity headers, return 200 |
| `GET /validate-optional` | the **same decision**, except that a request carrying no credential at all is answered 200 with `X-Auth-Anonymous: true` and no identity headers (ADR-0031). A credential that *is* presented and fails is refused exactly as above — absent is anonymous, invalid is still 401 |
| `GET /health` | 200 `healthy` |

## Where the token comes from

`Authorization: Bearer <jwt>` is the form every caller uses, and it wins
whenever it is present.

Since F-067-h there is a second: a **WebSocket upgrade** may carry it in
`Sec-WebSocket-Protocol` as `txnet.v1, <jwt>`. A browser cannot set headers on
`new WebSocket()` — that list is the one thing about the upgrade a page
chooses — and Traefik runs an upgrade through this middleware like any other
request, which is what lets one gate answer for both and is why realtime needs
no second identity model (ADR-0030).

The list is **anchored, never scanned**: exactly two entries, `txnet.v1` first
and the token second. Anything else is `auth.authorizationRequired`. Scanning
for the marker would let a caller append a second credential after one already
rejected; the header is attacker-controlled, so its shape is matched, not
interpreted. `gateway-service` selects `txnet.v1` in the handshake response and
never the token — a selected subprotocol is echoed on the 101.

Additive: an `Authorization` header behaves exactly as before, so this is a
patch and not a version bump (`00-PROTOCOL.md` §8).

## The optional gate

`/validate-optional` exists for one router: realtime. A WebSocket on this
platform is the live-data transport and is opened before anyone signs in — the
OTP delivery result is pushed onto one during registration (F-067-j) — so an
upgrade with no credential has to reach `gateway-service` rather than be
refused here. Not gating the path at all would move the check into that
service, which is the second identity model ADR-0030 exists to avoid. This is
the third answer: one gate, one decision, two outcomes.

**Absent is anonymous; invalid is still 401.** A credential that was presented
and did not check out is never downgraded to "nobody". Downgrading it would
turn an expired token into a silent loss of privilege — a page that shows
nothing instead of one told to sign in again — and would let a caller reach an
admitted state by corrupting its own token, which is the one thing an optional
gate must not offer.

"Presented" is read broadly and deliberately: an `Authorization` header with
anything in it, or a `Sec-WebSocket-Protocol` list carrying more than the
marker. A malformed list is therefore a 401 rather than a quiet admission. The
bare marker — `new WebSocket(url, ['txnet.v1'])`, which is what a page with no
token sends — is the ordinary anonymous upgrade.

Traefik reaches it through a second middleware, `my-auth-optional`. It is a
separate middleware rather than a flag because ForwardAuth's address is what
chooses the behaviour and a router selects a middleware by name; every other
router keeps `my-auth` and is unaffected.

## Response headers on success

The declared list, the Traefik forward and strip lists, and how the two are
checked differently: **[contract.headers.md](contract.headers.md)**. Split out
at ~200 lines (§10); it is one self-contained topic with its own gate.

## Status mapping

- 200 valid. 401 missing/invalid/expired token or missing session marker
  (`auth.authorizationRequired`, `auth.invalidToken`, `auth.sessionRevoked`).
  403 policy denies a claimed permission (`permissions.forbidden`). 500 Redis
  lookup error / unexpected (`system.unexpected`). 503 the request outlived the
  gateway's timeout (`system.unavailable`). The key is mapped to the status
  **before** translation.
- Every failure key is a generated constant (`auth-handler/internal/i18nkeys`),
  the same catalogue `auth-service` answers from in TypeScript (F-081). A key
  renamed in `errors.json` is a build failure here, not a raw key on a screen.
- **A 2xx `msg` is `ok`, and `ok` is not a translation key.** That is safe only
  because failures alone are translated — a success body is consumed by
  Traefik or a health probe and never read by a person. A success body that
  starts reaching a person needs a real key first.

## Every answer is the envelope, and `msg` is a sentence

`{ok, msg}`, with `msg` translated into `Accept-Language` from the shared
backend `errors` namespace (`locales/backend/langs/*/errors.json`) — the same
catalogue `auth-api` translates against.

- A key here **must exist in `errors`**. Until v2 this gateway translated
  against a namespace called `messages`, which `locale-service` does not serve
  and never did: every lookup fell through and the client was sent the raw key
  (`session_revoked`). A caller shows `msg` to a person, so its language is not
  a nicety.
- The answers no handler wrote — a recovered panic, a timeout — carry the same
  envelope in the same language. `Recoverer` and `Timeout` therefore sit
  **inside** `LanguageMiddleware`; `cmd/server/main.go` says so.
- A 2xx body is consumed by Traefik and never reaches a person, so success is
  not translated.
- Nothing internal is ever on the wire: a Go error's text and a panic value go
  to the log alone (`response.SafeExecute`), the rule `auth-api`'s
  `sanitizeError` follows on the other side.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | the JWT claim shape + the meaning of a live session | cannot authorize -> everything protected fails closed |
| redis-keyspace | `<REDIS_KEY_NAMESPACE>:<REDIS_KEYSPACE_VERSION>:session:<id>` must match what `auth-service` writes | mismatch = every request looks "revoked" |
| i18n | localize the response `msg` (`scope=backend`, namespace `messages`) | falls back to the raw key |

## Config

`JWT_SECRET` (or `JWT_ACCESS_SECRET`) — must equal `auth-service`'s;
`REDIS_URL`; `REDIS_KEY_NAMESPACE` / `REDIS_KEYSPACE_VERSION` — must equal
`auth-service`'s; `PERMISSIONS_FILE_PATH` (`configs/permissions.yaml`, optional —
absent disables the RBAC step); `LOCALE_SERVICE_ADDR` / `LOCALE_SCOPE=backend`;
HTTP timeouts. Policy file format: `roles: <role>: permissions: - <key>`, where `<role>` is `identity.role.name` spelled as `prisma/seed.js` spells it (ADR-0037).

## Guarantees

- Fail-closed: any error or unmet check returns non-2xx, so Traefik blocks the
  request.
- `alg` confusion is not possible — verification always uses HS256.
- The gateway never writes to Redis or Postgres; it is read-only.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `LOCALES_DIR` / `LOCALES_WATCH` config fields | 2026-09-04 | — | `locale-service` is the only file reader |
