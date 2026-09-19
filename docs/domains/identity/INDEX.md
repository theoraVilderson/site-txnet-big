---
id: identity
layer: domain
status: active
version: 22
keywords: [users, roles, manage roles, create a role, edit a role, role permissions, staff role, نقش‌ها, ساختن نقش, ویرایش نقش, دسترسی‌های نقش, find a user, user search, user picker, جستجوی کاربر, reseller owner login, my reseller panel, handoff, پنل نمایندگی من, owner on own domain, owner in reseller bot chat, مالک در ربات نماینده, login, auth, rbac, roles, permissions, sessions, otp, otp channel, otp delivery push, channel token, delivery result, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset, phone number, e164, phone format, country, email, email address, verify email, email verification, smtp, ایمیل, تایید ایمیل, شماره موبایل, فرمت شماره]
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
  - txnet-backend/auth-service/src/app/auth/handoff/handoff.service.ts
  - txnet-backend/auth-service/src/app/auth/users/user-search.service.ts
  - txnet-backend/auth-service/src/app/auth/roles/**
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-09-19
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts, and their verified email address. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-09-19 | Contract v21 -> **v22** (additive, F-018-n, ADR-0062, D-42 (2)): a role may belong to a tenant (`role.tenantId` nullable, null = a system template) and a tenant administers its own at `/auth/roles`; invariant 18, invariant 9 now enforced. New topic file [contract.roles.md](contract.roles.md). The token path is unchanged — it keys a role by id. Consumers: auth-api (v25, same change), forward-auth (none needed), panel-web (not yet — F-018-j) |
| 2026-09-18 | Contract v20 -> **v21** (additive, F-018-ad): "find a user" — `GET /auth/users?q=`, `user.search` + platform-owner tenant only, masked phone, no email. Consumers: auth-api (v24, same change), panel-web (F-018-ae) |
| 2026-09-18 | Contract v19 -> **v20** (additive, F-061-f, ADR-0059 (7)): hand off from the platform panel to a reseller's own panel domain with a single-use code; invariant 17. Consumers: auth-api (v22, same change), panel-web (the button and `/auth/handoff`, same change) |
| 2026-09-18 | Contract v18 -> **v19** (additive, F-061-i, ADR-0059 (6)): the chat session (`/auth/bots/session`) on a reseller's bot also signs in its owner — through their own contact-verified link, or by linking their contact card in their own tenant (one link per person per messenger). No shape changed. Consumers: bot-app (none needed) |
| 2026-09-18 | Contract v17 -> **v18** (additive, F-061-g, ADR-0059 (5)): the three prove-account operations and the Mini App session on a reseller's domain also accept its owner's own account and run in the owner's tenant. A Mini App verifies with the door's bot and looks in the door's tenant first, whatever session is already on the request; its scope key names that tenant (`bot:<tenantId>:<platform>:<chatId>`) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
