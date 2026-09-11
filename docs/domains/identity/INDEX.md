---
id: identity
layer: domain
status: active
version: 12
keywords: [users, login, auth, rbac, roles, permissions, sessions, otp, otp channel, otp delivery push, channel token, delivery result, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset, phone number, e164, phone format, country, شماره موبایل, فرمت شماره]
source:
  - txnet-backend/prisma/domains/identity.prisma
  - txnet-backend/auth-service/src/app/auth/auth.service.ts
  - txnet-backend/auth-service/src/app/auth/token.service.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp.service.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp-channels.service.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp.interface.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp-delivery.store.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp-delivery.publisher.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp-internal.controller.ts
  - txnet-backend/auth-service/src/app/auth/otp/senders/**
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-session.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.store.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.messages.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.types.ts
  - txnet-backend/auth-service/src/app/auth/register/register.service.ts
  - txnet-backend/auth-service/src/app/auth/session/session.service.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.service.ts
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-09-10
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-09-10 | Contract v11 -> **v12** (additive, F-067-j): the OTP delivery result is **pushed**. The three issuing operations also hand back `channel` + `channelToken`, the realtime channel that carries the result (ADR-0031); the Redis status stays as the record a client that missed the event reads (D-15). Recording a state and publishing it are one operation, so console mode pushes too. spec: F-067-j |
| 2026-09-10 | Contract v10 -> **v11** (breaking, F-067-a): OTP delivery leaves the request path. The three issuing operations answer **202** with a `deliveryId` and gained *read OTP delivery status* beside them; the code is drawn by whoever sends it, so nothing plaintext rides the queue (invariant #2). The broker becomes a dependency of OTP login — console delivery still runs inline. spec: F-067-a |
| 2026-09-09 | Contract v9 -> **v10** (breaking in meaning, catalog 10.5): a `linked_bot_account` is unique within a tenant — `@@unique([tenantId, platform, platformUserId])` and a new `tenantId` column, migration `20260909000400_bot_link_unique_per_tenant`. `linkedBotAccount` joins `user` in `TENANT_SCOPED_MODELS`, so no lookup site changed. The version history moved to `contract.versions.md` (§10, 250 lines). spec: F-315 |
| 2026-09-09 | Contract v8 -> **v9** (breaking in meaning, ADR-0023): `user.username` and `user.phoneNumber` are unique **within a tenant**, not across the platform. Two resellers may now hold the same customer. No operation changed shape and no consumer call site changed — `withTenant` scopes the lookups (ADR-0024). spec: F-065-b |
| 2026-09-09 | Contract v7 -> **v8** (breaking in meaning, ADR-0024): `register` no longer takes a tenant argument — it reads the ambient scope `tenant-context` opens at the edge. Same refusal, same wire; one in-process call site, `auth-api`, updated in the same change. spec: F-1203 |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
