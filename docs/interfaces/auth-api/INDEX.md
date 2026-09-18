---
id: auth-api
layer: interface
status: active
version: 14
keywords: [auth api, handoff endpoint, reseller panel handoff, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint, mini app session, webapp session, initdata]
source:
  - txnet-backend/auth-service/src/main.ts
  - txnet-backend/auth-service/src/app/auth/auth.controller.ts
  - txnet-backend/auth-service/src/app/auth/auth.guard.ts
  - txnet-backend/auth-service/src/app/auth/auth.module.ts
  - txnet-backend/auth-service/src/app/auth/auth.schema.ts
  - txnet-backend/auth-service/src/app/auth/handoff/handoff.controller.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.controller.ts
  - txnet-backend/auth-service/src/app/automation/bot-integration.controller.ts
  - txnet-backend/auth-service/src/app/automation/worker-admin.controller.ts
  - txnet-backend/auth-service/src/app/common/security/service-caller.ts
  - txnet-backend/auth-service/src/app/common/guards/service-only.guard.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.schema.ts
  - txnet-backend/auth-service/src/app/auth/captcha/**
  - txnet-backend/auth-service/src/app/auth/decorators/**
  - txnet-backend/auth-service/src/app/auth/guards/**
  - txnet-backend/auth-service/src/app/auth/register/register.controller.ts
  - txnet-backend/auth-service/src/app/auth/register/register.schema.ts
  - txnet-backend/auth-service/src/app/common/**
  - txnet-backend/shared-core/src/lib/envelope/**
  - txnet-backend/auth-service/src/app/config/**
  - txnet-backend/auth-service/src/app/locale/**
  - txnet-backend/auth-service/src/app/prisma/**
  - txnet-backend/auth-service/src/app/redis/redis.module.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.controller.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.module.ts
  - txnet-backend/auth-service/src/app/impersonation/guards/**
  - txnet-backend/auth-service-e2e/**
owns_tables: []
depends_on: [identity, i18n, redis-keyspace, tenant, automation]
updated: 2026-09-18
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, impersonation and worker administration included), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API), [contract.switch-scope.md](contract.switch-scope.md) (which account group a call acts on), [contract.cookies.md](contract.cookies.md) (the refresh cookie), [contract.rate-limits.md](contract.rate-limits.md) (how every limit in that table is counted), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-09-18 | Contract v22 -> **v23** (breaking, F-018-ab, ADR-0058 (2)): `/internal/vault/destroy-expired` and `/internal/vault/gateway-credential*` are `tenant-service`'s (`domains/tenant/contract.vault.md`); the stale `/internal/tenant-subscriptions/*` row (moved by F-018-v) is dropped. Consumers `automation` (worker) and `billing` moved in the same change |
| 2026-09-18 | Contract v21 -> **v22** (additive, F-061-f): `GET`/`POST /auth/handoff` and `POST /auth/handoff/redeem`. Consumer `panel-web` in the same change |
| 2026-09-18 | Contract v20 -> **v21** (breaking, F-066-u, ADR-0060): the refresh and `device_id` cookies are host-only, and every refresh-cookie write or clear also expires the old `Domain=.<DOMAIN_NAME>` one; `/api/auth` is routed on every host. Consumer `panel-web` moved in the same change (v19); `bot-app` sends no cookie. [contract.cookies.md](contract.cookies.md) |
| 2026-09-13 | Contract v19 -> **v20** (breaking, F-099): the `/admin/*` aliases are removed ahead of their date, on the user's call; no consumer called them |
| 2026-09-13 | Contract v18 -> **v19** (breaking, F-098): the `/admin/*` routes answer under `/auth/*`; `/admin` stays a deprecated alias until 2026-10-13. Consumers `panel-web`, `bot-app` call none of them. Also additive: `GET /auth/me` (F-097) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
