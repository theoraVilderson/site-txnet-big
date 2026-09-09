---
id: forward-auth
layer: platform
status: active
version: 2
keywords: [forward auth, traefik, gateway, jwt, rbac, permissions, permissions file, policy engine, role, engine.go, policy.go, gateway error message, session_revoked, untranslated key]
source:
  - auth-handler/**
owns_tables: []
depends_on: [identity, i18n, redis-keyspace]
updated: 2026-09-08
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
| [contract.md](contract.md) | changing the validate flow, headers, or policy file |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from existing auth-handler during onboarding |
| 2026-09-05 | RBAC keywords added; `forward-auth-rbac-policy` surface row |
| 2026-09-08 | v1 -> **v2**, breaking: `msg` keys move to the shared `errors` namespace and are actually translated; panic and timeout answer with the envelope too. Consumers of a blocked request's body: `panel-web`, `bot-app` — both show `msg` verbatim, so both improve with no change |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
