---
id: auth-api
layer: interface
status: active
version: 7
keywords: [auth api, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint]
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
updated: 2026-09-06
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, `/admin/*` impersonation), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-09-06 | Contract v6 -> **v7** (breaking, ADR-0015): every `/auth/accounts/*` route now acts on the group of the *calling surface* — a `device_id` cookie for a browser, `x-bot-platform` + `x-bot-chat-id` for a bot chat — instead of one global group per person. New route `POST /auth/accounts/remove` (F-0208), which revokes only that scope's sessions. Consumers `panel-web` and `bot-app` updated in the same change |
| 2026-09-06 | Additive: the switch group's five routes, `POST /auth/accounts/add/*` (F-0205) + `GET /auth/accounts` (F-0206) + `POST /auth/accounts/switch` (F-0207). Bearer required, F-0101 deliberately not applied, rate-limited per caller rather than per IP. `withRefreshCookie`/`cookieOptions` moved out of `auth.controller.ts` into `common/http/refresh-cookie.ts` — two controllers mint sessions now, and two definitions of that cookie would mean two cookies |
| 2026-09-06 | Additive: `POST /auth/bots/session` — signing in as the messenger account itself (ADR-0012) |
| 2026-09-05 | Tests, no code change: `auth-service-e2e` now drives the real app over HTTP against a containerised Postgres + Redis — signup/OTP/login/refresh/logout, forgot -> verify -> reset (incl. the total revocation), both gates, and the envelopes/cookie/CORS of this contract. Added to `source:`. Two contract mismatches it surfaced are in [open-questions.md](open-questions.md) |
| 2026-09-05 | Breaking (F-0204), v5: `POST /auth/password/reset` now returns session tokens + sets the refresh cookie (the revocation is unchanged and still total). Additive in the same version: `GET /auth/otp/channels`, `POST /auth/bots/link/status`, `POST /auth/bots/:platform/webhook/:secret`, and the `linkRequired` response variant on both OTP-request routes (F-0202, F-0203). Consumer `panel-web` updated in the same change |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
