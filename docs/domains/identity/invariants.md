---
id: identity
layer: domain
status: active
updated: 2026-09-17
---

# Invariants — identity

Statements that must be true at all times. **Outrank every feature request.**

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `passwordHash`, `twoFactorSecret`, `otp_code.codeHash` are never returned by a default select and never logged | service-layer `select`/`omit`; `sanitizeError` | credential disclosure |
| 2 | The plain OTP code and plain refresh token are never persisted — only an argon2id hash (OTP) / HMAC hash (refresh). **Nor does the code cross a process boundary** (F-067-a): it is drawn inside the one process that sends it, and the message that asks for a send carries the phone, purpose and channel but never a code | `OtpService.mint` + `deliverOtp` (the only two places a code exists), `TokenService`; `otp.service.spec.ts` asserts the published message's exact field set | token replay if the store — or now the queue — leaks |
| 3 | A password change or reset revokes every session of that user (Postgres `updateMany` + Redis `dropAllForUser`) in one transaction. A session issued to the resetting device *after* that revocation is not an exception to it — no session that existed before the reset survives | `AuthService.resetPassword` | stolen session survives password change |
| 4 | JWT verification always uses HS256 regardless of the token header `alg` | `TokenService.verify`, Go `jwt.Validate` | `alg:none` / alg-confusion forgery |
| 5 | Every User has exactly one `tenantId` and one `roleId` (both non-null FKs) | schema NOT NULL FKs | orphaned / cross-tenant identity |
| 6 | An account with `phoneVerifiedAt = null` cannot complete password login, and the key that says so (`auth.phoneVerificationRequired`) is returned only *after* the password has been verified — before that point every rejection is the single `auth.invalidCredentials` answer | `AuthService.loginWithPassword` | unverified accounts act as real users; an anonymous account-existence oracle |
| 7 | Impersonation requires a target strictly lower in role rank than the admin, an active target, and a reason note >= 10 chars; it is always written to `admin_audit_log`. The impersonation row, the session row and the audit row commit in **one** transaction, and the session's Redis marker is written only after that commit — a failed audit write leaves no session behind | `ImpersonationService` | privilege escalation, unaudited access |
| 8 | Sessions in Postgres are the record; the Redis marker is only the liveness cache — a missing marker means "revoked", never "unknown, allow" | `AuthGuard`, `auth-handler` | revoked session accepted |
| 9 | `isSystemRole` roles cannot be deleted | schema intent (`Role.isSystemRole`) — **not yet constraint-enforced** | RBAC lockout |
| 10 | OTP: at most one active code per (tenant, phone, purpose); >5 attempts destroys it | `OtpStore` Lua script + `setNx` lock, over keys carrying `<tenantId>` (ADR-0023, F-065-c) | brute force, code flooding — and, before the tenant segment, one reseller's code evicting another's for the same number |
| 13 | The failed-login counter is keyed on the **normalized** identifier — the same value the account lookup uses — so one account is one lock regardless of how the phone number was spelled | `AuthService.loginWithPassword` | the 10/900s lock multiplied by every accepted phone format |
| 12 | A `linked_bot_account` may only carry an OTP once `contactVerifiedAt` is set, and it is only set from a contact whose `contact.user_id` equals the sender's id and whose phone equals the number the code was requested for. One `(tenantId, platform, platformUserId)` belongs to at most one User — **within a tenant**, not across the platform (F-066-l): the chat id is the messenger's, so the same person is the same id in every reseller's bot, and a platform-wide rule would let whoever linked first hold the chat against all the others | `BotLinkService.handleContact` + `@@unique([tenantId, platform, platformUserId])`, scoped by `withTenant`; senders filter on `contactVerifiedAt` | a forged contact card redirects someone else's OTP to the attacker's chat — and, unscoped, one reseller's link silently answering another's `/start` |
| 11 | Register creates no `user` row until phone OTP verification succeeds; the submitted profile + password hash live only in Redis (`register:pending:<tenantId>:<phone>`) until then | `RegisterService.register` / `.verifyPhone` | unclaimed/abandoned "semi-active" accounts occupying a username or phone number |
| 14 | A token's `permHash` and the fingerprint written to `role:<roleId>:permissions` are computed by the **one** function (`permissionFingerprint`) over the **one** relation (`role.rolePermissions.permission.key`); Redis is rewritten by a Postgres trigger's notification, never by an application write path, and a missing key refuses nobody (ADR-0043) | `TokenService`, `PermissionNotificationsListener`, migration `20260913000000_identity_permissions_notify`; `permission-notifications.listener.spec.ts` compares a written fingerprint with a minted one | two computations drifting reads as every token on the platform being stale at once; a missed notification leaves a changed role honoured until the next connect |
| 15 | `user.email` is written only after an `email_verify` code mailed to that address verified, so a non-null address is a proven one; asking for the code reads no other account. The `email` channel carries `email_verify` only, and `email_verify` travels by `email` only — a mailed login code would make the inbox a second password | `MeEmailService.confirm`; `OtpChannelRegistry.assertUsable(channel, purpose)`; `me-email.spec.ts`, `otp-channels.service.spec.ts` | an unproven address receives campaign mail (F-035-h); an address enumeration oracle; login by inbox |
| 16 | The only account a sign-in reads outside the surface's tenant is the one `tenant.ownerUserId` names, matched by the typed identifier (the 2FA and reset steps: the token's subject), and only after no account of the surface's tenant matched; the rest of that sign-in — the OTP code key included — runs in the owner's tenant (ADR-0059) | `SurfaceOwnerService.ownerMatching`, `AuthService.loginWithPassword` / `requestLoginOtp` / `verifyLoginOtp` / `forgotPassword` / `verifyForgotPassword` / `resetPassword`; `surface-owner.service.spec.ts`, `auth.service.spec.ts` | a login oracle across tenants; an owner session keyed under the reseller's tenant |
| 16 | An OTP SMS under a reseller goes out on the platform's line **only to that reseller's owner**; its staff and users get the reseller's own line or no SMS, never the platform's number (D-41) | `SmsOtpSender.lineTenant`, the one place that decides; `OtpChannelRegistry` hands it the destination on every check and send (`otp-senders.spec.ts`) | a reseller's customer sees the platform's number; the platform pays for a reseller's SMS |

## How to test

1. Repository/service unit tests assert `passwordHash` absent from returned DTOs.
2. `OtpService` test: issue twice within cooldown -> 429; 6th verify -> exhausted.
   Since F-067-a also: `issueOtp` publishes and draws nothing, a publish the
   broker did not confirm leaves no cooldown behind, and `deliverOtp` stores an
   argon2id hash and never the code (`otp.service.spec.ts`).
3. `AuthService.resetPassword` test: pre-existing session `isActive()` -> false after.
4. `TokenService.verify` test: token with `alg:none` header -> `UnauthorizedException`.
5. `ImpersonationService` test: equal/greater role -> `ForbiddenException`; audit
   row created; a failing audit write mints no token and leaves no live session.
6. Login test: 11th bad password within window -> `auth.temporarilyLocked`, and
   `09...` / `+989...` / `00989...` all count against that same window.
10. Login test: an unverified account answers `auth.invalidCredentials` on a
    wrong password and `auth.phoneVerificationRequired` only on the right one.
7. `RegisterService` test: after `register()`, `prisma.user.findFirst` for that
   phone/username returns nothing; only after a correct `verifyPhone()` does
   the row exist, with `phoneVerifiedAt` already set.
8. `BotLinkService` test: a contact whose `user_id` differs from `message.from.id`
   leaves `linked_bot_account` untouched and the link `failed`; the same contact
   with a matching id, but a phone other than the requested one, is also refused.
   A link written with a tenant in scope carries that tenant, and the write
   fails outright without one (`with-tenant.spec.ts`, `bot-link.service.spec.ts`).
9. `TelegramOtpSender` test: a `linked_bot_account` row with
   `contactVerifiedAt = null` -> `otp.telegramNotLinked`, no message sent.

## Session scope (ADR-0015)

A session's `scopeKey` is written once, at mint time, and thereafter only ever
**copied** — `refresh` carries the old row's value onto the replacement. It is
never re-derived from a request and never cleared. A session whose scope was
re-derived would migrate between surfaces as a user's cookies changed; one
whose scope was dropped would fall out of its own switch group on the first
rotation, which for the panel is the first page load. Pinned in
`auth.service.spec.ts` ("carries the scope forward onto the replacement
session").

Nullable is a real value, not a gap: an impersonation session belongs to no
switch group and must match no scope, so `F-0208`'s scoped revoke never touches
one.
