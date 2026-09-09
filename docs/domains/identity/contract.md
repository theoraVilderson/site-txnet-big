---
id: identity
layer: domain
status: active
version: 10
updated: 2026-09-09
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
| register | fullName, username, phone, strong password. The tenant is **ambient**, not an input (v8) | phoneNumber, `requiresPhoneVerification` | sync | duplicate, weak/profile password, no resolved tenant |
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
| prove account by password | identifier (phone or username), password | the account, or **null** for every failure alike | sync | `auth.temporarilyLocked` (shares login's 10/900s bucket) |
| issue account-proof OTP | phone, optional channel | nothing, or the same `linkRequired` deep-link shape as login OTP | sync | channel not allowed / not configured |
| prove account by OTP | phone, code | the account, or **null** | sync | — |
| hand over a session | outgoing sessionId + userId, the target user, ip, user-agent, **switch scope** | the target's `{accessToken, refreshToken, expiresIn}`, stamped with that scope; the outgoing session revoked `account_switched` | sync tx | (the caller has already decided the switch is allowed) |
| revoke a user's sessions **in one scope** | userId, scopeKey, reason | the count revoked; only sessions minted in that scope, markers dropped one by one | sync | — |
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
  The replacement **inherits the old row's `scopeKey`** — a refresh is the same
  session continuing (ADR-0015). It is never re-derived from the request, and
  never dropped: the panel refreshes on every page load, so either mistake
  would detach a live session from its switch group within seconds.
- Password reset and (any) password change revoke **every** session for that
  user, in one Postgres transaction, and drop the Redis markers. Reset then
  mints one new session for the device that performed it — issued after the
  revocation, so "every other device is signed out" holds while the person who
  just reset their password is not bounced back to the login form.
- OTP channels are per-environment (`OTP_ALLOWED_CHANNELS` + whether each
  sender is configured). A channel that is off is never offered and is refused
  if named; it is never silently substituted.
- A messenger channel delivers only to a `linked_bot_account` with
  `contactVerifiedAt` set **in the requesting tenant**. Otherwise the caller
  gets a bot deep link, for any phone number alike — see invariants #12.
- OTP: one active code per (phone, purpose); 5 attempts; 60s request cooldown;
  300s code TTL. Redis is the source of truth (ADR-0007).
- Register creates no `user` row until phone verification succeeds — the
  submitted profile + hashed password sit in Redis (`register:pending:<phone>`,
  600s TTL) and are discarded (never promoted) if verification doesn't happen
  in time. See identity/invariants.md #11.
- Login lockout: `LOGIN_FAILURE_LOCK_THRESHOLD` failed attempts (default 10) per
  identifier per 900s -> `temporarily locked` (Redis counter, cleared on
  success). The threshold is deployment config — a white-label deployment with
  a different risk appetite sets it without a rebuild — so a caller must treat
  `temporarily locked` as the contract and the count as an environment detail.
- Enumeration-safe: OTP request / forgot-password always return `{accepted:true}`.
- The three **prove account** operations exist for `audit`'s account-switch
  group (F-0205) and mint nothing — no session, no token, no cookie. They
  answer one thing: does this credential belong to that account. Every failure
  (wrong credential, no such account, deleted, inactive, unverified phone)
  returns the same `null`, so a caller holding one session cannot use them to
  learn which numbers are registered. `account_switch_link` is its own
  `OtpPurpose`: invariant #10 allows one active code per (phone, purpose), so
  sharing login's purpose would let adding an account destroy a login code the
  same person is mid-way through typing.
- **Hand over a session** (F-0207) checks no credential — `audit` has already
  decided that the target belongs to the caller's group, and that decision is
  the credential. What identity guarantees is only that the two session writes
  are one: the outgoing row is revoked in the same transaction that writes the
  incoming one, and the Redis markers are then updated outgoing-first, so
  `AuthGuard` never sees two live sessions for the one browser. The new token
  carries the **target's** role and permissions; nothing is inherited.

## v10 — a bot link is unique within a tenant

**Breaking, in meaning rather than in shape.** A messenger account
(`linked_bot_account`) was bound to at most one User across the whole platform;
it is now bound within a tenant (`@@unique([tenantId, platform, platformUserId])`,
migration `20260909000400_bot_link_unique_per_tenant`). Catalog 10.5 is why, and
it scopes linking at the **tenant**, not at the bot: a person who starts in a
reseller's sales bot is the same person in that reseller's support bot.

What changes for a caller is what an answer *means*, not what it looks like:

- **link messenger account** refuses `chat already linked elsewhere` about the
  requesting tenant only. The same chat may hold a link with every reseller on
  the platform, and none of them is told the others exist. Before this, whoever
  linked a chat first held it against everyone else — and a chat id is issued by
  the messenger, so it is the same id in every bot.
- The OTP senders resolve a chat within the requesting tenant, so a code is
  never delivered to a chat that proved itself to somebody else's bot.

No operation gained or lost a parameter, and no wire shape moved.
`linkedBotAccount` joins `user` in `TENANT_SCOPED_MODELS`, so the ten lookup
sites were not edited (`platform/tenant-context/contract.md`); the three writes
name the ambient tenant only because Prisma's create input requires the column.
The pending-link pointer `botlink:chat:*` gains the same tenant segment its two
neighbours already carry — the last phone-adjacent key F-065-c left tenant-free
(`platform/redis-keyspace/contract.md`).

**Affected consumers** (every unit listing `identity` in `depends_on`): audit,
billing, currency, engagement, fraud, governance, network, notification, ai,
support, tenant, auth-api, forward-auth. None of them queries identity's tables
and none passes a chat id for another tenant, so no consumer call site changes.
Nothing is deprecated, because no shape is removed.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `verify phone (register)` keyed by `userId` | 2026-09-04 | already removed — no `user` row exists at register time to key by | keyed by `phoneNumber` instead |
| silent SMS fallback when a messenger is not linked | 2026-09-05 | already removed (catalog C-20) | `linkRequired` + bot deep link on the channel the user chose |

## Version history

v9 and older moved to [contract.versions.md](contract.versions.md) when this
file reached 250 lines (§10). The shapes above are current; that file answers
"when did this change, and who did it break".
