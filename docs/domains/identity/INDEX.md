---
id: identity
layer: domain
status: active
version: 40
keywords: [owner setup, setup required, first sign-in of the platform owner, اولین ورود صاحب پلتفرم, اکانت پیش‌فرض پلتفرم, نام کاربری و رمز جدید صاحب پلتفرم, import users from another panel, imported user, remote identity, کاربر انتقالی, telegram id from old panel, imported telegram link, آیدی تلگرام مشتری‌های قبلی, temporary access, a key for a window, key with start and end, دسترسی موقت, دسترسی زمان‌دار, active sessions, my sessions, end a session, terminate session, نشست‌های فعال, مدیریت نشست, بستن نشست, impersonate a reseller's user, impersonation under consent, ورود به‌جای کاربر نماینده, time zone, timezone, user time zone, منطقه زمانی, ساعت کاربر, notice messenger, messenger for notices, telegram or bale for notices, پیام‌رسان اعلان‌ها, users, roles, manage roles, create a role, edit a role, role permissions, staff role, نقش‌ها, ساختن نقش, ویرایش نقش, دسترسی‌های نقش, find a user, user search, user picker, جستجوی کاربر, reseller owner login, my reseller panel, handoff, پنل نمایندگی من, owner on own domain, owner in reseller bot chat, مالک در ربات نماینده, login, auth, rbac, roles, permissions, sessions, otp, otp channel, otp delivery push, channel token, delivery result, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset, phone number, e164, phone format, country, email, email address, verify email, email verification, smtp, ایمیل, تایید ایمیل, شماره موبایل, فرمت شماره]
source:
  - txnet-backend/auth-service/src/app/auth/owner-setup/owner-setup.service.ts
  - txnet-backend/auth-service/src/app/auth/owner-setup/offer-owner-setup.ts
  - txnet-backend/auth-service/src/app/auth/otp/phone-code-sender.service.ts
  - txnet-backend/prisma/domains/migrations/20261026000200_the_owner_sets_itself_up/**
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
  - txnet-backend/auth-service/src/app/auth/me/me-messenger.service.ts
  - txnet-backend/auth-service/src/app/auth/me/me-time-zone.service.ts
  - txnet-backend/auth-service/src/app/auth/me/me-account.service.ts
  - txnet-backend/shared-core/src/lib/mail/mail-provider.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/link-writes.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-session.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.store.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.messages.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.types.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/messenger-phone.ts
  - txnet-backend/auth-service/src/app/auth/register/register.service.ts
  - txnet-backend/auth-service/src/app/auth/session/session.service.ts
  - txnet-backend/auth-service/src/app/auth/session/active-sessions.service.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation.service.ts
  - txnet-backend/auth-service/src/app/impersonation/impersonation-leash.ts
  - txnet-backend/prisma/domains/migrations/20261004000400_impersonation_rides_on_consent/**
  - txnet-backend/auth-service/src/app/auth/surface-owner/surface-owner.service.ts
  - txnet-backend/auth-service/src/app/auth/handoff/handoff.service.ts
  - txnet-backend/auth-service/src/app/auth/users/user-search.service.ts
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.service.ts
  - txnet-backend/auth-service/src/app/auth/users/authority.ts
  - txnet-backend/auth-service/src/app/auth/roles/**
  - txnet-backend/auth-service/src/app/auth/permissions/access.ts
  - txnet-backend/auth-service/src/app/auth/permissions/access.reader.ts
  - txnet-backend/auth-service/src/app/auth/permissions/key-window.sweep.ts
  - txnet-backend/auth-service/src/app/auth/permissions/key-window-internal.controller.ts
  - txnet-backend/prisma/domains/migrations/20261013000500_a_key_given_for_a_window/**
  - txnet-backend/auth-service/src/app/auth/users/user-status.service.ts
  - txnet-backend/prisma/domains/migrations/20261009000500_a_key_given_to_one_person/**
  - txnet-backend/prisma/domains/migrations/20261014000100_admin_and_support_roles_become_groups/**
  - txnet-backend/shared-core/src/lib/time/time-zone.ts
  - txnet-backend/auth-service/src/app/auth/users/user-import.service.ts
  - txnet-backend/auth-service/src/app/auth/users/user-import-internal.controller.ts
  - txnet-backend/auth-service/src/app/auth/users/end-user-room.ts
  - txnet-backend/prisma/domains/migrations/20261021000300_an_imported_user_keeps_its_source_identity/**
owns_tables: [user, session, role, permission, role_permission, user_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-10-22
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts, and their verified email address. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [contract.sessions.md](contract.sessions.md) (a person's active sessions), [contract.account.md](contract.account.md) (a person's own name and password), [contract.owner-setup.md](contract.owner-setup.md) (a fresh install owner's first sign-in), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.access.md](contract.access.md) (what a person may do), [contract.reseller-users.md](contract.reseller-users.md) (a reseller's own users), [contract.import.md](contract.import.md) (the people an import from another panel brings), [contract.blocked-accounts.md](contract.blocked-accounts.md) (restricted and banned accounts), [contract.messenger.md](contract.messenger.md) (which messenger a user's notices take), [contract.time-zone.md](contract.time-zone.md) (which wall clock a user is read in), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-10-22 | Contract v39 -> **v40** (additive, F-210, ADR-0157): `linked_bot_account.claimedAt`; `telegramId` on `POST /api/internal/users/import` and `POST …/import/telegram` — a source's Telegram id is a claim the chat's own card redeems at `bots/session`. [contract.import.md](contract.import.md). Consumers: entitlement, billing (same change) |
| 2026-10-21 | Contract v38 -> **v39** (additive, F-211, D-63): `POST /api/internal/users/import/remove` — an import's rollback removes the people it made who did nothing here; see [contract.import.md](contract.import.md) |
| 2026-10-21 | Contract v37 -> **v38** (additive, F-201-e, D-63): `user.remoteIdentity` (unique per tenant) and `POST /api/internal/users/import` — an import finds or creates its people by the source's key. [contract.import.md](contract.import.md). Consumers: entitlement (F-207, not built yet) |
| 2026-10-14 | Contract v36 -> **v37** (behaviour change, SA-1-b, ADR-0145): the holder of `*` signs in only with password and code; every one-factor door refuses them, a reset leaves them signed out. [invariants.md](invariants.md) 22. Consumers: auth-api, panel-web (same change) |
| 2026-10-14 | Contract v35 -> **v36** (additive, SA-1-a): at most `SUPERADMIN_MAX` (default 2) people hold `*`; the assign refuses `superadmin_limit`, boot warns past it. [contract.roles.md](contract.roles.md). Consumers: auth-api (same change) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
