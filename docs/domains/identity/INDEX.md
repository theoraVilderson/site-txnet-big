---
id: identity
layer: domain
status: active
version: 30
keywords: [active sessions, my sessions, end a session, terminate session, نشست‌های فعال, مدیریت نشست, بستن نشست, impersonate a reseller's user, impersonation under consent, ورود به‌جای کاربر نماینده, time zone, timezone, user time zone, منطقه زمانی, ساعت کاربر, notice messenger, messenger for notices, telegram or bale for notices, پیام‌رسان اعلان‌ها, users, roles, manage roles, create a role, edit a role, role permissions, staff role, نقش‌ها, ساختن نقش, ویرایش نقش, دسترسی‌های نقش, find a user, user search, user picker, جستجوی کاربر, reseller owner login, my reseller panel, handoff, پنل نمایندگی من, owner on own domain, owner in reseller bot chat, مالک در ربات نماینده, login, auth, rbac, roles, permissions, sessions, otp, otp channel, otp delivery push, channel token, delivery result, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset, phone number, e164, phone format, country, email, email address, verify email, email verification, smtp, ایمیل, تایید ایمیل, شماره موبایل, فرمت شماره]
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
  - txnet-backend/auth-service/src/app/auth/me/me-messenger.service.ts
  - txnet-backend/auth-service/src/app/auth/me/me-time-zone.service.ts
  - txnet-backend/auth-service/src/app/auth/me/me-account.service.ts
  - txnet-backend/shared-core/src/lib/mail/mail-provider.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-session.service.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.store.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.messages.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.types.ts
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
  - txnet-backend/shared-core/src/lib/time/time-zone.ts
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-10-09
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts, and their verified email address. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [contract.sessions.md](contract.sessions.md) (a person's active sessions), [contract.account.md](contract.account.md) (a person's own name and password), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.reseller-users.md](contract.reseller-users.md) (a reseller's own users), [contract.blocked-accounts.md](contract.blocked-accounts.md) (restricted and banned accounts), [contract.messenger.md](contract.messenger.md) (which messenger a user's notices take), [contract.time-zone.md](contract.time-zone.md) (which wall clock a user is read in), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-10-09 | Contract v29 -> **v30** (additive, AC-1-f): the permission registry — generated from `permissions.yaml` by `tools/permissions-gen.py`, texts in the `permissions` locale namespace, held by `contracts.py`. [contract.roles.md](contract.roles.md). Consumers: auth-api (v43, same change), panel-web (F-1201-d) |
| 2026-10-09 | Contract v28 -> **v29** (additive, F-1201-a, ADR-0134): a tenant's roles on its own path, up to the tenant ceiling, and assigning one to a person (`role_change` audited; invariants 18). `RolesService` queries now tenant-bound. [contract.roles.md](contract.roles.md). Consumers: auth-api (v42, same change), panel-web (F-1201-c/d), tenant (F-1201-b) |
| 2026-10-05 | Contract v27 -> **v28** (additive, UX-1-t): a person renames themselves and changes their password signed in — the current one asked, this place kept, the others ended through SES-1-a when asked. [contract.account.md](contract.account.md). Consumers: auth-api (v41, same change), panel-web (UX-1-u) |
| 2026-10-05 | Contract v26 -> **v27** (additive, SES-1-a): a person lists every place they are signed in and ends the others; ending a place also takes the account out of that place's switch group and, on a bot chat, deletes its own link there. [contract.sessions.md](contract.sessions.md) |
| 2026-10-02 | Contract v25 -> **v26** (additive, TZ-1-a/b/c, ADR-0108): a user's time zone — shared-core `resolveTimeZone` (user -> browser -> tenant -> `Asia/Tehran`), `user.timezone` + `timezoneSource`, `tenant.timezone`; a browser report never overwrites a choice. [contract.time-zone.md](contract.time-zone.md). Consumers: auth-api (v38, same change), tenant (column only; TZ-1-d), notification/automation (TZ-1-f/g), panel-web (TZ-1-e) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
