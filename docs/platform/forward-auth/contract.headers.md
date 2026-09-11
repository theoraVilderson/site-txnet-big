---
id: forward-auth
layer: platform
status: active
version: 3
updated: 2026-09-11
---

# forward-auth — headers on the wire

The normative half of this unit's contract that Traefik, Go and TypeScript all
have to agree on. Split out of `contract.md` at ~200 lines (§10): it is one
topic, with one fixture and one gate of its own.

## Response headers on success

**`contracts/http/wire.json` is the normative list; the table below is a
reading of it.** Every name here is declared there once and imported —
`auth-handler/internal/api/handlers/headers.go` on the writing side,
`shared-core/src/lib/http/headers.ts` on the reading side, and
`tools/contracts.py` holds the Traefik lists to the same file (ADR-0036, C-04).
A name that appears here and not there is a documentation bug, and three tests
say so: `headers_contract_test.go`, `wire.contract.spec.ts` and the sixth gate.

The fixture is hand-written rather than generated because Traefik reads YAML
and has no toolchain that could consume generated Go or TypeScript.

| header | value | set when |
|---|---|---|
| `X-User-Id` | `sub` | every success |
| `X-Tenant-Id` | `tenantId` | every success |
| `X-Role-Id` | `roleId` | every success |
| `X-Session-Id` | `sessionId` | every success |
| `X-User-Permissions` | claimed permissions, comma-joined | every success |
| `X-Impersonated` | `true` | only while impersonating |
| `X-Impersonated-By` | the acting admin | only while impersonating |
| `X-Auth-Anonymous` | `true` | `/validate-optional` only, **instead of** all of the above |

The split between the first five and the impersonation pair is part of the
contract, not an implementation detail: a consumer asking "did the gate
identify someone" checks a set that is present on every success, or an
ordinary signed-in request reads as a failure. `headers_contract_test.go`
asserts a real `/validate` response carries exactly the first five, exactly the
pair when impersonating, and no `X-` header the fixture does not declare —
which is the direction that actually rotted (`X-Actor-Id` sat in Traefik's
strip list for months with no writer and no reader).

`X-Auth-Anonymous: true` is set **instead of all of them**, and only by
`/validate-optional`, when the caller presented nothing. It is what lets a
consumer tell "the gate ran and identified nobody" from "the gate never ran" —
without it the two are the same absence of headers, and a router that lost its
middleware would silently downgrade every authenticated socket. Like every
header here it must be both forwarded (`authResponseHeaders`) and stripped
(`strip-fake-headers`): a header downstream reads as evidence that the gate ran
is a header a client must not be able to set. Traefik is configured to forward
exactly these (`authResponseHeaders`) and to strip every one of them from the
inbound request (`strip-fake-headers`).

`X-Session-Id` is new with F-067-h and is the only one that names the *grant*
rather than the person. It exists because a WebSocket outlives by hours the
~15-minute token that opened it, so a consumer holding one has to re-ask the
question this handler answered once — and it can only ask about a session it
was told the id of. `realtime` is its only consumer today; it re-reads
`session:<id>` on a timer and closes the socket when the marker is gone,
applying this gateway's own rule (a missing marker is *revoked*, never
"unknown, allow"). Adding it to `authResponseHeaders` **and** to
`strip-fake-headers` is both halves of one change: forwarded but not stripped
is a header a client can forge.

## How the two Traefik lists are checked

`tools/contracts.py` compares both lists with the fixture, and it checks them
**differently**. That asymmetry is part of this contract, not an implementation
detail of the script:

| list | asserted as | why |
|---|---|---|
| `strip-fake-headers` | **superset** of the declared names | it is a security boundary. Stripping a header nothing writes is correct defence in depth — `X-Actor-Id` has sat there unwritten for months, and removing it would open a forgeable header the day somebody adds a reader |
| `forwardauth.authResponseHeaders` | **equal** to the declared names | it is a data contract. A missing entry does not fail loudly: the header never arrives, the consumer reads `undefined`, and the request proceeds as an anonymous or wrong-tenant identity |

Reversing the two is the failure the gate exists to prevent. A middleware whose
name contains `optional` is also expected to forward `X-Auth-Anonymous`; one
pointing at `/validate` must not, because a gate that cannot answer "nobody"
has nothing to say with it.

The gate's first run found that `X-Impersonated` and `X-Impersonated-By` were
forwarded and never stripped. `my-auth` happened to cover them — Traefik
deletes every header in `authResponseHeaders` from the request before copying
the auth response onto it — but that is a property of one middleware, not a
boundary, and a router carrying `strip-fake-headers` without a ForwardAuth
would have passed a client-set `X-Impersonated: true` straight through.

## The permission file is held to the TypeScript guards

`tools/contracts.py` also asserts that every permission name enforced by a Nest
`PermissionsGuard` is granted to some role in `auth-handler/configs/permissions.yaml`,
and that the default role `RegisterService` looks up by name exists in both
`prisma/seed.js` and that file (F-085, ADR-0036).

It is the same shape as the header contract and fails the same way: Go enforces
the YAML as defence in depth, Nest enforces an inline array, and a name in one
and not the other makes a route **unreachable** rather than merely ungated —
`auth-handler` refuses any token claiming a permission the role is not granted,
before the request reaches the service that would have allowed it.

Its first run found three: `worker.manage`, `bot.webhook_rotate` and
`realtime.tenant.read` were all enforced in TypeScript and granted to nobody.

It also asserts that **every** role `prisma/seed.js` creates has an entry in the
file, spelled the same. The engine looks the role up by the token's `roleName`
claim, never by `roleId` — a database UUID no checked-in file can address — so a
seeded role missing from the file is refused on every gated request (ADR-0037).
