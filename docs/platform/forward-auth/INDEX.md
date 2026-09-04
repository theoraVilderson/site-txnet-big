---
id: forward-auth
layer: platform
status: active
version: 1
keywords: [forward auth, traefik, gateway, jwt]
source:
  - auth-handler/**
owns_tables: []
depends_on: [identity, i18n, redis-keyspace]
updated: 2026-09-04
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

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
