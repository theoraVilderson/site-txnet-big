---
id: identity
layer: domain
status: active
version: 15
keywords: [users, reseller owner login, owner account, linked account, credential link, login, auth, rbac, roles, permissions, sessions, otp, otp channel, otp delivery push, channel token, delivery result, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset, phone number, e164, phone format, country, email, email address, verify email, email verification, smtp, ایمیل, تایید ایمیل, شماره موبایل, فرمت شماره]
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
  - txnet-backend/auth-service/src/app/auth/notify/**
  - txnet-backend/auth-service/src/app/auth/otp/senders/**
  - txnet-backend/auth-service/src/app/auth/me/me-email.service.ts
  - txnet-backend/shared-core/src/lib/mail/mail-provider.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-session.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.store.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.messages.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.types.ts
  - txnet-backend/auth-service/src/app/auth/register/register.service.ts
  - txnet-backend/auth-service/src/app/auth/session/session.service.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.service.ts
  - txnet-backend/auth-service/src/app/auth/linked-account/linked-account.service.ts
  - txnet-backend/prisma/domains/migrations/20260918000000_user_credential_link/**
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-09-18
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts, and their verified email address. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-09-18 | Contract v14 -> **v15** (additive, F-061-c, ADR-0059): a **linked account** (`user.credentialUserId`) signs in with the named account's password and 2FA; *create owner account* (internal). Migration `20260918000000_user_credential_link`. Consumers: none yet — F-018-y calls it, F-061-d enters through it |
| 2026-09-17 | Contract v13 -> **v14** (additive, F-035-g, D-39): *request email code* (202, the OTP worker path) and *confirm email*, the only write of `user.email`; `email` is an OTP channel reserved to `email_verify` (invariant #15). Migration `20260917000600_user_email`. spec: F-035-g |
| 2026-09-10 | Contract v11 -> **v12** (additive, F-067-j): the OTP delivery result is **pushed**. The three issuing operations also hand back `channel` + `channelToken`, the realtime channel that carries the result (ADR-0031); the Redis status stays as the record a client that missed the event reads (D-15). Recording a state and publishing it are one operation, so console mode pushes too. spec: F-067-j |
| 2026-09-10 | Contract v10 -> **v11** (breaking, F-067-a): OTP delivery leaves the request path. The three issuing operations answer **202** with a `deliveryId` and gained *read OTP delivery status* beside them; the code is drawn by whoever sends it, so nothing plaintext rides the queue (invariant #2). The broker becomes a dependency of OTP login — console delivery still runs inline. spec: F-067-a |
| 2026-09-09 | Contract v9 -> **v10** (breaking in meaning, catalog 10.5): a `linked_bot_account` is unique within a tenant — `@@unique([tenantId, platform, platformUserId])` and a new `tenantId` column, migration `20260909000400_bot_link_unique_per_tenant`. `linkedBotAccount` joins `user` in `TENANT_SCOPED_MODELS`, so no lookup site changed. The version history moved to `contract.versions.md` (§10, 250 lines). spec: F-315 |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
