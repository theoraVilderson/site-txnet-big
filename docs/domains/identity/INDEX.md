---
id: identity
layer: domain
status: active
version: 19
keywords: [users, reseller owner login, owner on own domain, owner in reseller bot chat, مالک در ربات نماینده, login, auth, rbac, roles, permissions, sessions, otp, otp channel, otp delivery push, channel token, delivery result, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset, phone number, e164, phone format, country, email, email address, verify email, email verification, smtp, ایمیل, تایید ایمیل, شماره موبایل, فرمت شماره]
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
  - txnet-backend/auth-service/src/app/auth/surface-owner/surface-owner.service.ts
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
| 2026-09-18 | Contract v18 -> **v19** (additive, F-061-i, ADR-0059 (6)): the chat session (`/auth/bots/session`) on a reseller's bot also signs in its owner — through their own contact-verified link, or by linking their contact card in their own tenant (one link per person per messenger). No shape changed. Consumers: bot-app (none needed) |
| 2026-09-18 | Contract v17 -> **v18** (additive, F-061-g, ADR-0059 (5)): the three prove-account operations and the Mini App session on a reseller's domain also accept its owner's own account and run in the owner's tenant. A Mini App verifies with the door's bot and looks in the door's tenant first, whatever session is already on the request; its scope key names that tenant (`bot:<tenantId>:<platform>:<chatId>`) |
| 2026-09-18 | Contract v16 -> **v17** (additive, F-061-e, ADR-0059): `password/forgot`, `forgot/verify-otp` and `password/reset` on a reseller's domain also accept its owner's own account; the code, the revocation and the new session are in the owner's tenant. No shape changed. Consumers: panel-web (none needed) |
| 2026-09-18 | Contract v15 -> **v16** (additive, F-061-d, ADR-0059): OTP login and the 2FA step on a reseller's domain also accept its owner's own account; the code is issued, checked and the session opened in the owner's tenant. No shape changed. Consumers: panel-web (none needed) |
| 2026-09-18 | Contract v14 -> **v15** (additive, F-061-c, ADR-0059): password login on a reseller's domain also accepts its owner's own account, and completes in the owner's tenant. No shape changed. Consumers: panel-web (none needed) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
