---
id: auth-api
layer: interface
status: active
version: 1
keywords: [auth api, login endpoint, register endpoint, auth-service]
source:
  - txnet-backend/auth-service/src/**
owns_tables: []
depends_on: [identity, i18n, redis-keyspace]
updated: 2026-09-04
---

# auth-api

**Responsibility (one sentence):** the NestJS `auth-service` HTTP surface —
`/api/auth/*` (register, login, OTP, refresh, logout, password reset),
`/api/i18n/:lang/:ns`, and `/admin/*` impersonation — translating HTTP <-> the
`identity` domain.
**Explicitly NOT responsible for:** identity business rules/invariants
(`identity`), the edge token check on *other* services (`forward-auth`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | calling or changing the HTTP API |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from existing auth-service during onboarding |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
