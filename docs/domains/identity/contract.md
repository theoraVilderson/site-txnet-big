---
id: identity
layer: domain
status: active
version: 1
updated: 2026-09-04
---

# Contract — identity

The **only** legal way other units interact with identity. If it is not here, it
is private.

## TL;DR

Identity authenticates a User and mints a short-lived access JWT + an opaque
refresh token. Session liveness is a Redis marker (see `redis-keyspace`). Other
units receive identity facts as request headers set by `forward-auth`, never by
querying identity tables.

## Provides

Surfaced over HTTP by the `auth-api` interface — see
`interfaces/auth-api/contract.md` for the wire shapes. Semantic operations:

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| register | fullName, username, phone, strong password | userId, `requiresPhoneVerification` | sync | duplicate, weak/profile password |
| verify phone (register) | userId, 6-digit OTP | session tokens | sync | invalid/expired OTP |
| login (password) | identifier (phone or username), password | session tokens, or `requiresOtp` + `otpToken` | sync | invalid creds, phone-unverified, temporarily locked |
| request login OTP | phone, optional channel | `{accepted:true}` (never reveals existence) | sync | channel not allowed |
| verify login OTP | (`otpToken` \| phone) + code | session tokens | sync | invalid OTP/token |
| refresh | refresh token (body or cookie) | new session tokens (rotates) | sync | invalid/revoked/expired |
| logout | refresh token | `{success:true}` | sync | — (idempotent) |
| forgot password | phone, optional channel | `{accepted:true}` | sync | — |
| verify forgot OTP | phone, code | `resetToken` | sync | invalid OTP |
| reset password | resetToken, new password | `{success:true}`; revokes all sessions | sync | invalid token, profile-data password |
| start impersonation | targetUserId, reasonNote (>=10 chars) | impersonated access token (30 min) | sync | target not lower-ranked, target inactive |
| end impersonation | (from session) | — | sync | not an impersonation session |

Access-token claims (consumed by `forward-auth` and upstream services):
`sub`, `tenantId`, `roleId`, `permissions[]`, `sessionId`, `isImpersonated?`,
`impersonatedBy?`, `iat`, `exp`. Signing: HMAC-SHA256 (ADR-0004).

## Emits (events)

None. No message bus is wired up. Impersonation start/end write an
`audit.admin_audit_log` row **synchronously in the same transaction**.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| i18n | OTP message text + error strings for the request language | English fallback strings; delivery still attempted |
| redis-keyspace | session markers, OTP state, rate-limit + login-failure counters | auth fails closed (cannot create/verify sessions or OTP) |
| audit | `admin_audit_log`, `impersonation_session` rows on impersonation | impersonation transaction aborts |

## Guarantees

- Access JWT TTL `JWT_ACCESS_TTL_SEC` (default 900s); impersonation token 1800s.
- Refresh is single-use: `refresh` revokes the old session and issues a new one.
- Password reset and (any) password change revoke **every** session for that
  user, in one Postgres transaction, and drop the Redis markers.
- OTP: one active code per (phone, purpose); 5 attempts; 60s request cooldown;
  300s code TTL. Redis is the source of truth (ADR-0007).
- Login lockout: 10 failed attempts per identifier per 900s -> `temporarily
  locked` (Redis counter, cleared on success).
- Enumeration-safe: OTP request / forgot-password always return `{accepted:true}`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
