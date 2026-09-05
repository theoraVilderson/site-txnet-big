---
id: identity
layer: domain
status: active
version: 1
keywords: [users, login, auth, rbac, roles, permissions, sessions, otp, otp channel, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset]
source:
  - txnet-backend/prisma/domains/identity.prisma
  - txnet-backend/auth-service/src/app/auth/auth.service.ts
  - txnet-backend/auth-service/src/app/auth/token.service.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp.service.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp-channels.service.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp.interface.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp.placeholder.service.ts
  - txnet-backend/auth-service/src/app/auth/otp/senders/**
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.store.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.messages.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.types.ts
  - txnet-backend/auth-service/src/app/auth/register/register.service.ts
  - txnet-backend/auth-service/src/app/auth/session/session.service.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.service.ts
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-09-05
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-09-05 | OTP channels are now environment-switched (`OtpChannelRegistry`: `OTP_ALLOWED_CHANNELS` + "is the sender configured?"), and an unlinked messenger no longer falls back silently — it answers with a bot deep link. Adds `bot-link/**`, `LinkedBotAccount.phoneNumber`/`contactVerifiedAt`, `OtpPurpose.account_link`. spec: F-0202 F-0203 |
| 2026-09-05 | Password reset now revokes every session **and** issues one new session for the device that performed it (contract v3). Fix: `issueOtp` drew a 5-digit code while every schema demanded 6, so a code could never verify; fix: OTP/bot copy reads the `notifications` namespace, which is the one locale-service actually serves (it was asking for a non-existent `otp` namespace and silently falling back to English). spec: F-0204 |
| 2026-09-04 | Breaking (requested): `user` row is now created in verify-phone, not in register — see invariants.md #11, contract.md. `panel-web` updated to match. |
| 2026-09-05 | SYNC: narrowed `source:` from `app/auth/**` to the explicit service files this unit owns; captcha is `auth-api`'s (bot-check, not an identity rule) |
| 2026-09-05 | SYNC: `impersonation.controller.ts`/`.module.ts`/`guards/**` moved to `auth-api` (transport) — this unit keeps only `impersonation.service.ts` (the rules) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
