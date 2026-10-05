---
id: auth-api
layer: interface
status: active
version: 16
keywords: [ui preferences endpoint, display preferences endpoint, active sessions endpoint, terminate session endpoint, auth api, time zone endpoint, timezone endpoint, messenger endpoint, notice messenger endpoint, user groups endpoint, roles endpoint, role management endpoint, user search endpoint, handoff endpoint, reseller panel handoff, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint, mini app session, webapp session, initdata]
source:
  - txnet-backend/auth-service/src/main.ts
  - txnet-backend/auth-service/src/app/auth/auth.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/user-search.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.schema.ts
  - txnet-backend/auth-service/src/app/governance/user-groups/user-group.controller.ts
  - txnet-backend/auth-service/src/app/governance/ui-preferences/ui-preferences.controller.ts
  - txnet-backend/auth-service/src/app/governance/user-groups/user-group.schema.ts
  - txnet-backend/auth-service/src/app/auth/roles/roles.controller.ts
  - txnet-backend/auth-service/src/app/auth/roles/role.schema.ts
  - txnet-backend/auth-service/src/app/auth/auth.guard.ts
  - txnet-backend/auth-service/src/app/auth/auth.module.ts
  - txnet-backend/auth-service/src/app/auth/auth.schema.ts
  - txnet-backend/auth-service/src/app/auth/me/me.controller.ts
  - txnet-backend/auth-service/src/app/auth/session/active-sessions.controller.ts
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
updated: 2026-10-05
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, impersonation and worker administration included), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.time-zone.md](contract.time-zone.md) (the caller's time zone), [contract.sessions.md](contract.sessions.md) (the caller's active sessions), [contract.account.md](contract.account.md) (the caller's name and password), [contract.ui-preferences.md](contract.ui-preferences.md) (the caller's display preferences), [contract.reseller-bots.md](contract.reseller-bots.md) (connecting a named reseller's bot), [contract.reseller-users.md](contract.reseller-users.md) (a named reseller's own users), [contract.user-groups.md](contract.user-groups.md) (user groups), [contract.switch-scope.md](contract.switch-scope.md) (which account group a call acts on), [contract.cookies.md](contract.cookies.md) (the refresh cookie), [contract.messenger.md](contract.messenger.md) (the caller's notice messenger), [contract.rate-limits.md](contract.rate-limits.md) (how every limit in that table is counted), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-10-05 | Contract v40 -> **v41** (additive, UX-1-t): `PUT /auth/me/name`, `POST /auth/me/password` — a wrong current password is 400 `wrong_password`; `ME_NAME` 30/900s, `ME_PASSWORD` 5/900s. [contract.account.md](contract.account.md). Consumer: panel-web (UX-1-u) |
| 2026-10-05 | Contract v39 -> **v40** (additive, UX-1-k): `GET`/`PATCH /auth/me/ui-preferences` — motion, dashboard, pins, sidebar over governance `user_setting`; `unknown_preference` / `invalid_preference` / `preference_too_large` (400); `ME_UI_PREFERENCES` 120/900s. [contract.ui-preferences.md](contract.ui-preferences.md). Consumer: panel-web (UX-1-l) — not built yet |
| 2026-10-05 | Contract v38 -> **v39** (additive, SES-1-a): `GET /auth/sessions`, `POST /auth/sessions/terminate`, `POST /auth/sessions/terminate-others` — the caller's places and ending the others; `ME_SESSIONS` 30/900s. [contract.sessions.md](contract.sessions.md). Consumer: panel-web (SES-1-b, same change) |
| 2026-10-02 | Contract v37 -> **v38** (additive, TZ-1-c, ADR-0108): `GET`/`PUT /auth/me/timezone` — the caller's zone, `user` or `browser`, and the resolved one; a browser report never overwrites a choice; a non-IANA zone is 400. [contract.time-zone.md](contract.time-zone.md). Consumers: panel-web (TZ-1-e), bot-app (TZ-1-h) — not built yet |
| 2026-09-29 | Contract v36 -> **v37** (additive, F-311-ac, ADR-0103): `/auth/tenants/:id/users` rows gain `canAct` and `staff`; block/unblock may refuse `no_authority` (403). Consumers: panel-web (`UserRefusal` has the reason; `canAct` is F-311-ab's), bot-app (F-311-c) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
