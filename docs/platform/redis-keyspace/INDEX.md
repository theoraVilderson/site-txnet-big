---
id: redis-keyspace
layer: platform
status: active
version: 1
keywords: [redis, keyspace, session key, otp key, captcha key]
source:
  - txnet-backend/auth-service/src/app/redis/**
  - txnet-backend/auth-service/src/app/auth/session/**
  - txnet-backend/auth-service/src/app/auth/otp/otp.store.ts
  - txnet-backend/auth-service/src/app/auth/captcha/**
  - auth-handler/internal/cache/**
  - auth-handler/internal/config/config.go
owns_tables: []
depends_on: []
updated: 2026-09-05
---

# redis-keyspace

**Responsibility (one sentence):** the shared Redis key convention — the
`<namespace>:<version>:` prefix both auth services must agree on, plus the
catalogue of keys (sessions, OTP, rate limits) and their TTLs.
**Explicitly NOT responsible for:** the auth logic that uses the keys
(`identity` / `forward-auth`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | adding a Redis key, changing a TTL, or bumping the keyspace version |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from existing code during onboarding |
| 2026-09-04 | Added `register:pending:<phone>` (600s) for identity's register-then-verify flow |
| 2026-09-05 | Added `captcha:challenge:<id>` (60s) and `captcha:verified:<token>` (120s) for auth-api's captcha gate (F-0201) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
