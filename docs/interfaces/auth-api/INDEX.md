---
id: auth-api
layer: interface
status: active
version: 10
keywords: [auth api, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint, mini app session, webapp session, initdata]
source:
  - txnet-backend/auth-service/src/main.ts
  - txnet-backend/auth-service/src/app/auth/auth.controller.ts
  - txnet-backend/auth-service/src/app/auth/auth.guard.ts
  - txnet-backend/auth-service/src/app/auth/auth.module.ts
  - txnet-backend/auth-service/src/app/auth/auth.schema.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.controller.ts
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
depends_on: [identity, i18n, redis-keyspace]
updated: 2026-09-08
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, `/admin/*` impersonation), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-09-08 | v9 -> **v10**, breaking (ADR-0018): `phoneNumber` is E.164 in every request and response, and numbers from every country are accepted — it was the Iranian national form and nothing else. Consumers: `panel-web` updated in the same change (`PhoneField`), `bot-app` needs none, `forward-auth` never sees a number. `REDIS_KEYSPACE_VERSION` v1 -> v2 in the same deploy |
| 2026-09-08 | v8 -> **v9**, additive: `POST /auth/bots/webapp/session` (F-310, ADR-0017) — the Mini App presenting the `initData` its platform signed. The only public route on the bot controller, and the only one that mints a session under the *browser's* switch scope. The version history moved to `contract.versions.md` (§10, 250 lines) |
| 2026-09-07 | Contract v7 -> **v8** (additive, patch): both `POST /auth/accounts/add/*` verify routes now answer `userId` alongside `{groupId, added}` — the account that joined, on both the new-member and the already-a-member branch. Consumers: `bot-app` switches to it (F-0210), `panel-web` ignores it and needed no change |
| 2026-09-06 | Contract v6 -> **v7** (breaking, ADR-0015): every `/auth/accounts/*` route now acts on the group of the *calling surface* — a `device_id` cookie for a browser, `x-bot-platform` + `x-bot-chat-id` for a bot chat — instead of one global group per person. New route `POST /auth/accounts/remove` (F-0208), which revokes only that scope's sessions. Consumers `panel-web` and `bot-app` updated in the same change |
| 2026-09-06 | Additive: the switch group's five routes, `POST /auth/accounts/add/*` (F-0205) + `GET /auth/accounts` (F-0206) + `POST /auth/accounts/switch` (F-0207). Bearer required, F-0101 deliberately not applied, rate-limited per caller rather than per IP. `withRefreshCookie`/`cookieOptions` moved out of `auth.controller.ts` into `common/http/refresh-cookie.ts` — two controllers mint sessions now, and two definitions of that cookie would mean two cookies |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
