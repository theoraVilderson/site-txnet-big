---
id: auth-api
layer: interface
status: active
version: 20
keywords: [access history endpoint, access log endpoint, ui preferences endpoint, display preferences endpoint, active sessions endpoint, terminate session endpoint, auth api, time zone endpoint, timezone endpoint, messenger endpoint, notice messenger endpoint, user groups endpoint, roles endpoint, role management endpoint, user search endpoint, handoff endpoint, reseller panel handoff, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint, mini app session, webapp session, initdata]
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
  - txnet-backend/auth-service/src/app/auth/roles/tenant-roles.controller.ts
  - txnet-backend/auth-service/src/app/access-history/access-history.controller.ts
  - txnet-backend/auth-service/src/app/auth/permissions/permission-registry.controller.ts
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
updated: 2026-10-14
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, impersonation and worker administration included), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.time-zone.md](contract.time-zone.md) (the caller's time zone), [contract.sessions.md](contract.sessions.md) (the caller's active sessions), [contract.account.md](contract.account.md) (the caller's name and password), [contract.ui-preferences.md](contract.ui-preferences.md) (the caller's display preferences), [contract.reseller-bots.md](contract.reseller-bots.md) (connecting a named reseller's bot), [contract.reseller-users.md](contract.reseller-users.md) (a named reseller's own users), [contract.blocked-accounts.md](contract.blocked-accounts.md) (restricting and banning a person), [contract.user-groups.md](contract.user-groups.md) (user groups), [contract.switch-scope.md](contract.switch-scope.md) (which account group a call acts on), [contract.cookies.md](contract.cookies.md) (the refresh cookie), [contract.messenger.md](contract.messenger.md) (the caller's notice messenger), [contract.rate-limits.md](contract.rate-limits.md) (how every limit in that table is counted), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-10-14 | Contract v19 -> **v20** (additive, ADR-0137): the reseller user profile carries `ownsTenant`; impersonating the owner of any tenant is refused 403. [contract.reseller-users.md](contract.reseller-users.md). Consumers: panel-web (same change) |
| 2026-10-14 | Contract v18 -> **v19** (additive, SA-1-c, ADR-0145): the two-factor switch, `POST /auth/accounts/switch/password` then `/switch/code`, and `needsBothFactors` on each `GET /auth/accounts` member. [contract.switch-scope.md](contract.switch-scope.md). Consumers: panel-web (same change) |
| 2026-10-14 | Contract v17 -> **v18** (behaviour change, SA-1-b, ADR-0145): for the holder of `*` the password login always asks the code; a code alone and a handoff refuse `auth.ownerNeedsBothFactors`; a reset answers `signedOut:true` with no session. [contract.md](contract.md). Consumers: panel-web (reset goes to sign-in, same change), bot-app (already refused) |
| 2026-10-19 | Contract v55 -> **v56** (additive): every code-sent answer carries `resendIn` (the OTP cooldown, seconds; bot-link `status` too, counted from the bot's send), and the cooldown's 429 is `otp.cooldownActive` with `reason: otpCooldown`, `facts.retryAfter`. Signed-in captcha routes check the pass after the Bearer. [contract.md](contract.md). Consumers: panel-web counts these on login, register, forgot, add-account and the two-factor switch; bot-app ignores them. |
| 2026-10-14 | Contract v54 -> **v55** (additive, GR-1-x): each audience group carries `userCount`, its live user members, for the panel's picker. [contract.user-groups.md](contract.user-groups.md). Consumers: panel-web (GR-1-x, same change) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
