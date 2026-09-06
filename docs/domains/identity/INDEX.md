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
updated: 2026-09-06
---

# Identity
**Responsibility:** who a User is, how they authenticate (password / OTP), their RBAC role + permissions, their live sessions, and their linked Telegram/Bale accounts. **Not:** tenant staff roles (`tenant`), the edge token check (`forward-auth`), admin audit records (`audit`).
See [contract.md](contract.md), [invariants.md](invariants.md), [rules.md](rules.md), [data-model.md](data-model.md), [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-09-06 | Contract v5 -> **v6** (additive, ADR-0015): `Session.scopeKey` records the surface a session was minted on, `refresh` carries it forward, and a new scoped revoke (`revokeSessionsForUserInScope`) lets `audit`'s F-0208 sign an account out of one surface without touching the others. Adds `SessionRevokedReason.account_unlinked` |
| 2026-09-06 | contract v5 (additive): a **session handover** for `audit`'s switch (`AuthService.switchSession`) — one transaction revokes the outgoing session `account_switched` and writes the incoming one, then the Redis markers are updated outgoing-first so `AuthGuard` never sees two. New `SessionRevokedReason.account_switched` (migration). spec: F-0207 |
| 2026-09-06 | contract v4 (additive): three **prove account** operations for `audit`'s switch group — password, issue-OTP, verify-OTP. They mint nothing and answer `null` for every failure alike. New `OtpPurpose.account_switch_link`. spec: F-0205 |
| 2026-09-06 | ADR-0012: a contact-verified `linked_bot_account` authenticates its user directly (`bots/session`, `user` role only). Rules #13–#14 |
| 2026-09-06 | `BotLinkService` now *decides* and returns an outcome instead of also sending the message, so `bot-service` can drive the same flow over `bots/link/{resolve,contact}` — the contact proof (invariant #12) is still enforced here and only here. The `messenger` seed (`bot-client.registry.ts`, `telegram-like-bot.client.ts`) left this unit for `@txnet-backend/messenger` (ADR-0009's migration path). spec: F-303 |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
