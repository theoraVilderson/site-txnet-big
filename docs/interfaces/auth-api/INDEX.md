---
id: auth-api
layer: interface
status: active
version: 14
keywords: [auth api, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint, mini app session, webapp session, initdata]
source:
  - txnet-backend/auth-service/src/main.ts
  - txnet-backend/auth-service/src/app/auth/auth.controller.ts
  - txnet-backend/auth-service/src/app/auth/auth.guard.ts
  - txnet-backend/auth-service/src/app/auth/auth.module.ts
  - txnet-backend/auth-service/src/app/auth/auth.schema.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.controller.ts
  - txnet-backend/auth-service/src/app/automation/bot-integration.controller.ts
  - txnet-backend/auth-service/src/app/automation/worker-admin.controller.ts
  - txnet-backend/auth-service/src/app/tenant/vault/vault-internal.controller.ts
  - txnet-backend/auth-service/src/app/common/security/service-caller.ts
  - txnet-backend/auth-service/src/app/common/guards/service-only.guard.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.schema.ts
  - txnet-backend/auth-service/src/app/auth/captcha/**
  - txnet-backend/auth-service/src/app/auth/decorators/**
  - txnet-backend/auth-service/src/app/auth/guards/**
  - txnet-backend/auth-service/src/app/auth/register/register.controller.ts
  - txnet-backend/auth-service/src/app/auth/register/register.schema.ts
  - txnet-backend/auth-service/src/app/common/**
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
updated: 2026-09-11
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, `/admin/*` impersonation and worker administration), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API), [contract.switch-scope.md](contract.switch-scope.md) (which account group a call acts on), [contract.cookies.md](contract.cookies.md) (the refresh cookie), [contract.rate-limits.md](contract.rate-limits.md) (how every limit in that table is counted), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-09-10 | Contract v17 -> **v18** (ADR-0035): `/auth/logout` now falls back onto the place's group and may answer with another member's session (`switchedTo` + tokens, cookie replaced); new `/auth/logout/all` ends the place deliberately. **Consumers `panel-web` and `bot-app` both had to change** and did — one stays on the panel instead of routing to login, the other keeps the handed-back refresh token |
| 2026-09-10 | Contract v16 -> **v17** (ADR-0034): `/auth/accounts/switch` moves the whole place — it sweeps the outgoing account's other sessions in that scope and records the target on the scope's group, so the bot and its Mini App no longer disagree about who is signed in. An implicit sign-in (`bots/session`, `bots/webapp/session`) follows that pointer. Consumers: `panel-web`, `bot-app` — no call changes |
| 2026-09-10 | Contract v15 -> **v16** (ADR-0033): `POST /auth/logout` revokes every live session that account holds in the signing-out session's scope, not only the token's own — so a Mini App logout ends the bot chat's session too. Consumers: `panel-web`, `bot-app`; neither changes a call, both change what a logout means |
| 2026-09-10 | v13 -> **v14** (additive, F-067-j): the three 202 routes also return `channel` + `channelToken` — where the OTP delivery result is pushed and the proof needed to hear it (ADR-0031). `/internal/otp/deliver` gained `channelId`. The status route is unchanged and is still the record. spec: F-067-j |
| 2026-09-10 | v12 -> **v13** (breaking, F-067-a): `register`, `login/otp/request` and `password/forgot` answer **202** with a `deliveryId` instead of 200/201, and `POST /auth/otp/delivery/status` says what became of the send. `otp.smsSendFailed` is no longer returned by those routes. Row restored 2026-09-10 — the bump landed in `contract.md` and `contract.versions.md` without one here. spec: F-067-a |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
