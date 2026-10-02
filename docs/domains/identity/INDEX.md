---
id: identity
layer: domain
status: active
version: 26
keywords: [time zone, timezone, user time zone, منطقه زمانی, ساعت کاربر, notice messenger, messenger for notices, telegram or bale for notices, پیام‌رسان اعلان‌ها, users, roles, manage roles, create a role, edit a role, role permissions, staff role, نقش‌ها, ساختن نقش, ویرایش نقش, دسترسی‌های نقش, find a user, user search, user picker, جستجوی کاربر, reseller owner login, my reseller panel, handoff, پنل نمایندگی من, owner on own domain, owner in reseller bot chat, مالک در ربات نماینده, login, auth, rbac, roles, permissions, sessions, otp, otp channel, otp delivery push, channel token, delivery result, delivery method, telegram, bale, bot account, bot link, share contact, forgot password, password reset, phone number, e164, phone format, country, email, email address, verify email, email verification, smtp, ایمیل, تایید ایمیل, شماره موبایل, فرمت شماره]
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
  - txnet-backend/auth-service/src/app/auth/users/reseller-users.service.ts
  - txnet-backend/auth-service/src/app/auth/users/authority.ts
  - txnet-backend/auth-service/src/app/auth/roles/**
  - txnet-backend/shared-core/src/lib/time/time-zone.ts
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-10-02
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts, and their verified email address. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [contract.roles.md](contract.roles.md) (a tenant's own roles), [contract.reseller-users.md](contract.reseller-users.md) (a reseller's own users), [contract.messenger.md](contract.messenger.md) (which messenger a user's notices take), [contract.time-zone.md](contract.time-zone.md) (which wall clock a user is read in), [contract.versions.md](contract.versions.md) (when a shape changed and who it broke), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-10-02 | Contract v25 -> **v26** (additive, TZ-1-a/b/c, ADR-0108): a user's time zone — shared-core `resolveTimeZone` (user -> browser -> tenant -> `Asia/Tehran`), `user.timezone` + `timezoneSource`, `tenant.timezone`; a browser report never overwrites a choice. [contract.time-zone.md](contract.time-zone.md). Consumers: auth-api (v38, same change), tenant (column only; TZ-1-d), notification/automation (TZ-1-f/g), panel-web (TZ-1-e) |
| 2026-09-29 | Contract v24 -> **v25** (additive, F-311-ac, ADR-0103): authority over a person — block/unblock refuse `no_authority` (403) unless `authorityOver` allows; the users list gains `canAct` and `staff` per row. Invariant 18. Consumers: auth-api (v37, same change), panel-web (F-311-ab), bot-app (F-311-c) |
| 2026-09-28 | Contract v23 -> **v24** (additive, F-601-u, ADR-0097 part 2): a user chooses which messenger their notices take — Telegram, Bale or both; unchosen (`noticeMessenger` null) is both. [contract.messenger.md](contract.messenger.md). Consumers: auth-api (v36, same change), panel-web (`/settings`, same change), notification (none needed — the notifier is here) |
| 2026-09-20 | Contract v22 -> **v23** (additive, F-311-a, ADR-0064): a reseller reads and blocks its own users — list/block/unblock under `ResellerAccess`, `banned` outranks a block, every block revokes the account's sessions and audits to the reseller. New topic file [contract.reseller-users.md](contract.reseller-users.md). Consumers: auth-api (v29, same change), bot-app (F-311-c) |
| 2026-09-19 | Contract v21 -> **v22** (additive, F-018-n, ADR-0062, D-42 (2)): a role may belong to a tenant (`role.tenantId` nullable, null = a system template) and a tenant administers its own at `/auth/roles`; invariant 18, invariant 9 now enforced. New topic file [contract.roles.md](contract.roles.md). The token path is unchanged — it keys a role by id. Consumers: auth-api (v25, same change), forward-auth (none needed), panel-web (not yet — F-018-j) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
