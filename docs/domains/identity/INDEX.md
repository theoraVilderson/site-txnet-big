---
id: identity
layer: domain
status: active
version: 1
keywords: [users, login, auth, rbac, roles, permissions, sessions, otp, telegram, bale, bot account]
source:
  - txnet-backend/prisma/domains/identity.prisma
  - txnet-backend/auth-service/src/app/auth/**
  - txnet-backend/auth-service/src/app/impersonation/**
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-09-04
---

# Identity

**Responsibility (one sentence):** who a User is, how they authenticate
(password / OTP), their RBAC role + permissions, their live sessions, and
their linked Telegram/Bale accounts.
**Explicitly NOT responsible for:** tenant staff roles (`tenant`), the edge
token check (`forward-auth`), admin audit records (`audit`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing identity from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [rules.md](rules.md) | implementing inside this unit |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Unit documented from existing auth-service + schema (onboarding) |
| 2026-09-04 | Fix: `RedisService` had no `error` listener on the ioredis client — a connection failure during register's OTP flow crashed the whole auth-service process (Node's uncaught-`error`-event behaviour) instead of failing that one request. Added a listener that logs and lets the call reject normally. |
| 2026-09-04 | Fix: `OtpService.issueOtp` now honours `OTP_DELIVERY_MODE=console` / `OTP_DEV_CONSOLE_LOG` by logging the code and skipping the real sender, instead of always calling it — `SmsOtpSender` had no configured provider (`SMS_API_URL`/`SMS_API_KEY` unset) so register's OTP step always failed with `otp.smsNotConfigured`. |
| 2026-09-04 | Breaking (requested): `user` row is now created in verify-phone, not in register — see invariants.md #11, contract.md. `panel-web` updated to match. |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
