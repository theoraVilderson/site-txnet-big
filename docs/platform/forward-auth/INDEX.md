---
id: forward-auth
layer: platform
status: active
version: 3
keywords: [forward auth, traefik, gateway, identity headers, wire contract, header fixture, x-user-id, x-session-id, jwt, rbac, permissions, permissions file, policy engine, role, engine.go, policy.go, gateway error message, session_revoked, untranslated key, optional gate, anonymous, validate-optional, my-auth-optional, not signed in, socket without login]
source:
  - auth-handler/**
  - contracts/http/wire.json
  - tools/contracts.py
  - txnet-backend/shared-core/src/lib/http/**
owns_tables: []
depends_on: [identity, i18n, redis-keyspace]
updated: 2026-09-11
---

# forward-auth

**Responsibility (one sentence):** the Go Traefik ForwardAuth gateway
(`auth-handler`) — validate the access JWT, confirm the session is live in
Redis, enforce an RBAC policy file, and emit trusted `X-User-*` identity headers
for upstream services.
**Explicitly NOT responsible for:** issuing tokens or sessions (`identity` /
`auth-api`), any business logic.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | changing the validate flow or the policy file |
| [contract.headers.md](contract.headers.md) | changing a header, the fixture, or a Traefik list |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-11 | `tools/contracts.py` is the sixth gate: the Traefik strip list is asserted as a **superset** of the declared names (a security boundary) and `authResponseHeaders` as **equal** to them (a data contract). Its first run found `X-Impersonated`/`X-Impersonated-By` forwarded and never stripped; both are now in the strip list. spec: F-072 |
| 2026-09-11 | The header table becomes **normative**: `contracts/http/wire.json` is the declared home of every name this gateway writes, and Go, TypeScript and the Traefik lists are each held to it by a test (ADR-0036, C-04). No wire change. spec: F-071 |
| 2026-09-10 | v2 -> **v3** (additive, ADR-0031): `/validate-optional` — the same decision, but a caller presenting no credential is answered 200 with `X-Auth-Anonymous: true` and no identity headers. A presented credential that fails is still 401. One consumer, `realtime`, whose router moves to `my-auth-optional`; `/validate` and every other router are untouched. spec: F-067-j |
| 2026-09-08 | v1 -> **v2**, breaking: `msg` keys move to the shared `errors` namespace and are actually translated; panic and timeout answer with the envelope too. Consumers of a blocked request's body: `panel-web`, `bot-app` — both show `msg` verbatim, so both improve with no change |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
