---
id: auth-api
layer: interface
status: active
version: 16
keywords: [auth api, user groups endpoint, roles endpoint, role management endpoint, user search endpoint, handoff endpoint, reseller panel handoff, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint, mini app session, webapp session, initdata]
source:
  - txnet-backend/auth-service/src/main.ts
  - txnet-backend/auth-service/src/app/auth/auth.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/user-search.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.schema.ts
  - txnet-backend/auth-service/src/app/governance/user-groups/user-group.controller.ts
  - txnet-backend/auth-service/src/app/governance/user-groups/user-group.schema.ts
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
depends_on: [identity, i18n, redis-keyspace, tenant, automation, governance]
updated: 2026-09-28
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, impersonation and worker administration included), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.reseller-bots.md](contract.reseller-bots.md) (connecting a named reseller's bot), [contract.reseller-users.md](contract.reseller-users.md) (a named reseller's own users), [contract.user-groups.md](contract.user-groups.md) (user groups), [contract.switch-scope.md](contract.switch-scope.md) (which account group a call acts on), [contract.cookies.md](contract.cookies.md) (the refresh cookie), [contract.rate-limits.md](contract.rate-limits.md) (how every limit in that table is counted), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-09-28 | Contract v33 -> **v34** (additive, F-601-p): `POST /internal/notify/user` takes an optional `services` beside `count` — the services a combined retention notice is about, listed under its summary in the user's language (`retention.serviceLine…`, fa + en). Consumer `worker-service` in the same item |
| 2026-09-25 | Contract v32 -> **v33** (additive, F-114-j): `/auth/user-groups` — a tenant's user groups and their members, `user_group.manage`; only the platform owner's may hold resellers or another tenant's users. [contract.user-groups.md](contract.user-groups.md). No consumer on the wire yet |
| 2026-09-25 | Contract v31 -> **v32** (additive, F-067-p, ADR-0084 decision 3): `POST /internal/notify/user` takes an optional `count` (≥2) and tells the template's summary text; every template has one, fa + en. Consumer `worker-service` in the same item |
| 2026-09-25 | Contract v30 -> **v31** (**break**, F-067-o, ADR-0084): `POST /internal/notify/user` requires `channel` (`inbox` \| `bot`), one per call, and every template has an inbox title; `panelAccepted`, `panelRefused` added. Its one consumer, `worker-service`, moved in the same item. [contract.versions.md](contract.versions.md) |
| 2026-09-20 | Contract v28 -> **v29** (additive, F-311-a, ADR-0064): `GET /auth/tenants/:tenantId/users` and `POST`/`DELETE .../:userId/block` — a reseller's own users, admitted by `ResellerAccess` and never by a permission. [contract.reseller-users.md](contract.reseller-users.md). Consumer `bot-app` in F-311-c |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
