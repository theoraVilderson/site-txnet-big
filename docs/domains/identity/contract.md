---
id: identity
layer: domain
status: active
version: 3
updated: 2026-09-05
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
| register | fullName, username, phone, strong password | phoneNumber, `requiresPhoneVerification` | sync | duplicate, weak/profile password |
| verify phone (register) | phoneNumber, 6-digit OTP | session tokens | sync | invalid/expired OTP, pending registration expired |
| login (password) | identifier (phone or username), password | session tokens, or `requiresOtp` + `otpToken` | sync | invalid creds, phone-unverified, temporarily locked |
| list OTP channels | — | `{channels:[{channel, requiresLink}]}` — what this environment offers | sync | — |
| request login OTP | phone, optional channel | `{accepted:true}`, **or** `{accepted:true, linkRequired:true, platform, linkToken, deepLink, expiresIn}` when the chosen messenger is not connected yet | sync | channel not allowed / not configured / none available |
| poll bot link | linkToken | `{state:'pending'\|'linked'\|'failed', otpSent, failureKey?}` | sync | — |
| link messenger account | a contact shared with the bot | (in-chat) the account is linked and the pending code is sent | sync | contact not the sender's, phone mismatch, chat already linked elsewhere |
| verify login OTP | (`otpToken` \| phone) + code | session tokens | sync | invalid OTP/token |
| refresh | refresh token (body or cookie) | new session tokens (rotates) | sync | invalid/revoked/expired |
| logout | refresh token | `{success:true}` | sync | — (idempotent) |
| forgot password | phone, optional channel | `{accepted:true}`, or the same `linkRequired` shape as login OTP | sync | channel not allowed / not configured |
| verify forgot OTP | phone, code | `resetToken` | sync | invalid OTP |
| reset password | resetToken, new password | `{success:true}` + **session tokens for this device**; revokes every pre-existing session | sync | invalid token, profile-data password |
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
| redis-keyspace | session markers, OTP state, rate-limit + login-failure counters, pending-registration payloads | auth fails closed (cannot create/verify sessions or OTP); a pending registration lost before verify forces the user to register again |
| audit | `admin_audit_log`, `impersonation_session` rows on impersonation | impersonation transaction aborts |

## Guarantees

- Access JWT TTL `JWT_ACCESS_TTL_SEC` (default 900s); impersonation token 1800s.
- Refresh is single-use: `refresh` revokes the old session and issues a new one.
- Password reset and (any) password change revoke **every** session for that
  user, in one Postgres transaction, and drop the Redis markers. Reset then
  mints one new session for the device that performed it — issued after the
  revocation, so "every other device is signed out" holds while the person who
  just reset their password is not bounced back to the login form.
- OTP channels are per-environment (`OTP_ALLOWED_CHANNELS` + whether each
  sender is configured). A channel that is off is never offered and is refused
  if named; it is never silently substituted.
- A messenger channel delivers only to a `linked_bot_account` with
  `contactVerifiedAt` set. Otherwise the caller gets a bot deep link, for any
  phone number alike — see invariants #12.
- OTP: one active code per (phone, purpose); 5 attempts; 60s request cooldown;
  300s code TTL. Redis is the source of truth (ADR-0007).
- Register creates no `user` row until phone verification succeeds — the
  submitted profile + hashed password sit in Redis (`register:pending:<phone>`,
  600s TTL) and are discarded (never promoted) if verification doesn't happen
  in time. See identity/invariants.md #11.
- Login lockout: 10 failed attempts per identifier per 900s -> `temporarily
  locked` (Redis counter, cleared on success).
- Enumeration-safe: OTP request / forgot-password always return `{accepted:true}`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `verify phone (register)` keyed by `userId` | 2026-09-04 | already removed — no `user` row exists at register time to key by | keyed by `phoneNumber` instead |
| silent SMS fallback when a messenger is not linked | 2026-09-05 | already removed (catalog C-20) | `linkRequired` + bot deep link on the channel the user chose |

## Breaking: v3 — reset password returns a session

`reset password` used to answer `{success:true}` and leave the caller signed
out everywhere, including on the device in front of them. It now also returns
`{accessToken, expiresIn}` and sets the `refresh_token` cookie.
**Affected consumer:** `panel-web` — updated in the same change
(`lib/auth-api.ts` stores the token; the forgot-password screen goes to the
panel instead of the login form). A client that ignores the extra fields keeps
working; one that assumed "reset always means signed out" does not.
