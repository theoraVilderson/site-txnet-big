---
id: identity
layer: domain
status: active
version: 12
updated: 2026-09-10
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
| register | fullName, username, phone, strong password. The tenant is **ambient**, not an input (v8) | phoneNumber, `requiresPhoneVerification`, `deliveryId`, `channel`, `channelToken` | **async send** (v11) | duplicate, weak/profile password, no resolved tenant; broker unreachable |
| verify phone (register) | phoneNumber, 6-digit OTP | session tokens | sync | invalid/expired OTP, pending registration expired |
| login (password) | identifier (phone or username), password | session tokens, or `requiresOtp` + `otpToken` | sync | invalid creds, phone-unverified, temporarily locked |
| list OTP channels | — | `{channels:[{channel, requiresLink}]}` — what this environment offers | sync | — |
| request login OTP | phone, optional channel | `{accepted:true, deliveryId, channel, channelToken}`, **or** `{accepted:true, linkRequired:true, platform, linkToken, deepLink, expiresIn}` when the chosen messenger is not connected yet | **async send** (v11) | channel not allowed / not configured / none available; broker unreachable |
| poll bot link | linkToken | `{state:'pending'\|'linked'\|'failed', otpSent, failureKey?}` | sync | — |
| read OTP delivery status | deliveryId | `{state:'queued'\|'sent'\|'failed', failureKey?}` | sync | — |
| link messenger account | a contact shared with the bot | (in-chat) the account is linked and the pending code is sent | sync | contact not the sender's, phone mismatch, chat already linked elsewhere |
| verify login OTP | (`otpToken` \| phone) + code | session tokens | sync | invalid OTP/token |
| refresh | refresh token (body or cookie) | new session tokens (rotates) | sync | invalid/revoked/expired |
| logout | refresh token | `{success:true}` | sync | — (idempotent) |
| forgot password | phone, optional channel | `{accepted:true, deliveryId, channel, channelToken}`, or the same `linkRequired` shape as login OTP | **async send** (v11) | channel not allowed / not configured; broker unreachable |
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
- **The send is not in the request (v11).** Asking for a code takes the lock,
  the cooldown and the channel check and then stops; the code itself is drawn
  and sent by a consumer, and the caller learns what happened by reading the
  delivery status. `OTP_DELIVERY_MODE=console` still delivers inline, so a
  deployment without a broker can still register and log in.
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

## v11 — the send leaves the request path

**Breaking.** F-067-a. Every operation that issues a code used to make the
SMS / Telegram / Bale round trip inside the caller's request, and inside the
Redis lock it holds while doing so. A slow provider therefore held a lock and a
request on the process that also answers `/auth/login` — the failure ADR-0027
moved background work out of `auth-service` for, which OTP was never covered by.

What changed, and the one constraint that shaped it:

- **The code is drawn by whoever sends it.** D-15's note asked for the draw and
  the Redis save to stay in the request, with the message carrying the key they
  were saved under — but what is saved under that key is an argon2id hash, and
  a sender needs the code. Every arrangement that keeps the draw in the request
  puts the plaintext at rest, on the queue or in a second Redis entry, which
  invariant #2 forbids. So the draw moved instead. The message carries phone,
  purpose, channel, language and a delivery id; there is nowhere on it for a
  code to be.
- **The three issuing operations answer 202 with a `deliveryId`**, and gained a
  fourth alongside them: *read OTP delivery status*. D-15 makes the push
  (F-067-j) the primary channel and this the fallback a reconnecting client
  reads — so the status is not scaffolding, it is what F-067-j is built on.
- **A `deliveryId` is minted whether or not a code was issued**, and an id
  nobody minted answers `queued` like one still on the queue. The enumeration
  guarantee above is otherwise undone in one field.
- **`otp.smsSendFailed` can no longer be returned by these operations.** A send
  that fails does so after the answer; the failure is a `failed` delivery
  status carrying the same i18n key the sender threw.
- **The broker becomes a dependency of OTP login.** A publish the broker does
  not confirm fails the route (D-18) — password login is untouched, and console
  delivery never reaches the broker at all.
- *issue account-proof OTP* keeps its shape: it returns into an authenticated
  flow that has no 202 to carry an id. It is the one issuing operation a client
  cannot yet ask the status of.

## v12 — the delivery result is pushed (F-067-j)

D-15's other half. The three issuing operations now also hand back the realtime
channel that carries the result, so a client is told what became of its code
instead of asking on a timer.

- **`channel` and `channelToken` join `deliveryId` in the 202.** `channel` is
  `otp:<channelId>`; `channelToken` is what `realtime` demands before it will
  serve it (`realtime/contract.channels.md`, ADR-0031). All three are minted
  together, per request, **before anything is known about the phone number** —
  handles handed out only for a real account would answer the question
  `{accepted:true}` exists to refuse, and the channel would answer it a second
  time by accepting or refusing a subscription.
- **Three distinct values, not one reused three times.** A channel name reaches
  Redis pub/sub, gateway logs and metrics; the delivery id is the capability
  that reads the status. Reusing one would put that capability in all of those
  places for nothing.
- **The event carries `sent` / `failed` and a `failureKey`, never the code**
  (invariant #2). It is the same vocabulary the status answers with, so a
  client that missed the event and polls reads the identical two fields.
- **The status stays and is still the record.** A realtime event is
  at-most-once and is dropped when nobody is listening
  (`realtime/contract.fanout.md`), so the socket is the fast path and the
  status is the truth. A client that reconnects, or never opened a socket,
  loses nothing.
- **Recording the state and pushing it are one operation** (`OtpDeliveryStore.
  mark`). A caller able to do one without the other can leave a client waiting
  on a socket for an event about a status that already changed.
- *issue account-proof OTP* and the bot-link send mint handles nobody receives.
  The channel simply expires. Their callers hold no 202 and no token, so giving
  either flow a socket is a separate change.

**Affected consumers** (every unit listing `identity` in `depends_on`): audit,
billing, currency, engagement, fraud, governance, network, notification, ai,
support, tenant, auth-api, forward-auth. Only `auth-api` surfaces these
operations, and it is updated in the same change; `bot-app` reaches them
through `auth-api` and reads no status. Nothing is deprecated by removal — the
`{accepted:true}` shape gained a field rather than losing one — but a client
that treated 200 as the success condition must accept 202.

The same list applies to v12, with the same answer: `auth-api` is the only
consumer that surfaces the shape and it is updated here. `realtime` is a new
producer-side collaborator rather than a consumer of these operations —
`identity` publishes to a channel it names; it never asks the gateway anything.
Every added field is additive, so a client reading only `deliveryId` keeps
working and simply keeps polling.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `verify phone (register)` keyed by `userId` | 2026-09-04 | already removed — no `user` row exists at register time to key by | keyed by `phoneNumber` instead |
| silent SMS fallback when a messenger is not linked | 2026-09-05 | already removed (catalog C-20) | `linkRequired` + bot deep link on the channel the user chose |

## Version history

v10 and older live in [contract.versions.md](contract.versions.md) (§10). The
shapes above are current; that file answers "when did this change, and who did
it break".
