---
id: auth-api
layer: interface
status: active
version: 16
keywords: [auth api, roles endpoint, role management endpoint, user search endpoint, handoff endpoint, reseller panel handoff, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint, mini app session, webapp session, initdata]
source:
  - txnet-backend/auth-service/src/main.ts
  - txnet-backend/auth-service/src/app/auth/auth.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/user-search.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.schema.ts
  - txnet-backend/auth-service/src/app/auth/roles/roles.controller.ts
  - txnet-backend/auth-service/src/app/auth/roles/role.schema.ts
  - txnet-backend/auth-service/src/app/auth/auth.guard.ts
  - txnet-backend/auth-service/src/app/auth/auth.module.ts
  - txnet-backend/auth-service/src/app/auth/auth.schema.ts
  - txnet-backend/auth-service/src/app/auth/handoff/handoff.controller.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.controller.ts
  - txnet-backend/auth-service/src/app/automation/bot-integration.controller.ts
  - txnet-backend/auth-service/src/app/automation/worker-admin.controller.ts
  - txnet-backend/auth-service/src/app/automation/reseller-bot.controller.ts
  - txnet-backend/auth-service/src/app/automation/reseller-bot.schema.ts
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
updated: 2026-09-20
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, impersonation and worker administration included), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.reseller-bots.md](contract.reseller-bots.md) (connecting a named reseller's bot), [contract.reseller-users.md](contract.reseller-users.md) (a named reseller's own users), [contract.switch-scope.md](contract.switch-scope.md) (which account group a call acts on), [contract.cookies.md](contract.cookies.md) (the refresh cookie), [contract.rate-limits.md](contract.rate-limits.md) (how every limit in that table is counted), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-09-20 | Contract v28 -> **v29** (additive, F-311-a, ADR-0064): `GET /auth/tenants/:tenantId/users` and `POST`/`DELETE .../:userId/block` — a reseller's own users, admitted by `ResellerAccess` and never by a permission. [contract.reseller-users.md](contract.reseller-users.md). Consumer `bot-app` in F-311-c |
| 2026-09-20 | Contract v27 -> **v28** (additive, F-066-w5, ADR-0064): `GET`/`POST /auth/tenants/:tenantId/bots` and `DELETE .../:platform/:botUsername` — a reseller's bots, admitted by `ResellerAccess` and never by a permission. [contract.reseller-bots.md](contract.reseller-bots.md). Consumer `panel-web` in F-066-w6 |
| 2026-09-19 | Contract v26 -> **v27** (deprecation, F-018-ak, ADR-0065): `GET /auth/door` is `@deprecated` — the door question is tenant's `GET /api/public/tenant/serves-panel`, and the rule (`doorClosed`) is shared-core's. Consumer `panel-web` moved in the same item; removed after the next release |
| 2026-09-19 | Contract v25 -> **v26** (additive, F-066-x): `GET /auth/door` — `{serves}` for the host that asked, exempt from `TenantGuard`'s surface refusals. Consumer `panel-web` (same item) |
| 2026-09-19 | Contract v24 -> **v25** (additive, F-018-n, ADR-0062): `GET/POST /auth/roles`, `PATCH`/`DELETE /auth/roles/:id` — a tenant's own roles. [contract.roles.md](contract.roles.md). Consumer `panel-web` in F-018-j |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
