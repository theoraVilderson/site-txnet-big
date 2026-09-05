---
id: auth-api
layer: interface
status: active
version: 5
keywords: [auth api, login endpoint, register endpoint, auth-service, captcha, bot check, human verification, otp channels endpoint, bot webhook, telegram webhook, bale webhook, forgot password endpoint]
source:
  - txnet-backend/auth-service/src/main.ts
  - txnet-backend/auth-service/src/app/app.*
  - txnet-backend/auth-service/src/app/auth/auth.controller.ts
  - txnet-backend/auth-service/src/app/auth/auth.guard.ts
  - txnet-backend/auth-service/src/app/auth/auth.module.ts
  - txnet-backend/auth-service/src/app/auth/auth.schema.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.controller.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.schema.ts
  - txnet-backend/auth-service/src/app/auth/captcha/**
  - txnet-backend/auth-service/src/app/auth/decorators/**
  - txnet-backend/auth-service/src/app/auth/guards/**
  - txnet-backend/auth-service/src/app/auth/register/register.controller.ts
  - txnet-backend/auth-service/src/app/auth/register/register.schema.ts
  - txnet-backend/auth-service/src/app/common/**
  - txnet-backend/auth-service/src/app/config/**
  - txnet-backend/auth-service/src/app/i18n/**
  - txnet-backend/auth-service/src/app/locale/**
  - txnet-backend/auth-service/src/app/prisma/**
  - txnet-backend/auth-service/src/app/redis/redis.module.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.controller.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.module.ts
  - txnet-backend/auth-service/src/app/impersonation/guards/**
owns_tables: []
depends_on: [identity, i18n, redis-keyspace]
updated: 2026-09-05
---
# auth-api
**Responsibility:** NestJS `auth-service` HTTP surface (`/api/auth/*`, `/api/i18n/:lang/:ns`, `/admin/*` impersonation), translating HTTP <-> `identity`. **Not:** identity rules (`identity`), other services' edge check (`forward-auth`).
See [contract.md](contract.md) (HTTP API) and [open-questions.md](open-questions.md) (undecided items).
## Changelog
| Date | Change |
|---|---|
| 2026-09-05 | Fix (F-0201), no version bump: the captcha "single-use" the contract already promised now holds under concurrency. `verifyChallenge` burns the challenge with GETDEL and `consumePass` returns the DEL count, so two requests racing on one solved slide can no longer both win (GET-then-DEL / EXISTS-then-DEL let both through). Covered by `captcha.service.int.spec.ts` |
| 2026-09-05 | Breaking (F-0204), v5: `POST /auth/password/reset` now returns session tokens + sets the refresh cookie (the revocation is unchanged and still total). Additive in the same version: `GET /auth/otp/channels`, `POST /auth/bots/link/status`, `POST /auth/bots/:platform/webhook/:secret`, and the `linkRequired` response variant on both OTP-request routes (F-0202, F-0203). Consumer `panel-web` updated in the same change |
| 2026-09-05 | F-0101 (panel half): `/auth/refresh` now clears the `refresh_token` cookie when the token no longer resolves to a live session, so a dead token is not carried around forever. `panel-web`'s proxy calls this route server-to-server as its "is this visitor signed in?" check, and hands the browser whatever cookie decision comes back. Additive, no version bump (§8). |
| 2026-09-05 | Breaking (F-0201): `POST /auth/captcha/{challenge,verify}` + global `CaptchaGuard`. SYNC: split `source:` (was blanket `src/**`); added `impersonation.controller/.module.ts` + `guards/**` (transport, moved from `identity`) |
| 2026-09-05 | Breaking (F-0101): `NoActiveSessionGuard` — register/login/otp-* reject 409 `auth.alreadyAuthenticated` if already logged in; logout clears it. v4; consumer: `panel-web` (no UI for the 409 yet). Catalog row added by EXTEND after the code |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
