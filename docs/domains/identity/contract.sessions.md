---
id: identity
layer: domain
status: active
version: 27
updated: 2026-10-05
---

# Contract — identity / a person's active sessions

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. Seeing every place an account is signed in and ending the
others, Telegram-style (SES-1-a). Code:
`auth-service/src/app/auth/session/active-sessions.service.ts`. Wire shapes:
[auth-api/contract.sessions.md](../../interfaces/auth-api/contract.sessions.md).

## Operations

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| list my places | the caller's session | one entry per **place** — `{id, current, surface, ipAddress, userAgent, lastActiveAt}` — the current place first, then newest first | sync | — |
| end a place | the caller's session, a session id **of the caller's** (live or already rotated) | `{terminated: 1}`; that place ended (rules 3–5) | sync | `auth.sessionNotFound` (not the caller's, or no such id); `auth.sessionIsCurrent` |
| end every other place | the caller's session | `{terminated: n}` — every place but the caller's ended | sync | — |

## Rules

| # | Rule |
|---|---|
| 1 | The unit is the **place** (`session.scopeKey`, ADR-0015), not the row. A refresh mints a new row on every page load and a chat with its Mini App is one place holding two rows (ADR-0032), so a per-row list shows one device many times. A row with no scope (minted before ADR-0015) is its own place |
| 2 | A place is listed by its **newest** live row (`revokedAt` null, `expiresAt` in the future): that row's id is the handle and its `issuedAt` is `lastActiveAt`. An impersonation row is the admin's, never the account's: neither listed nor ended. The place key never leaves the service — a browser's is its `device_id` cookie |
| 3 | Ending a place revokes **every** session of the account there (`user_logout`, the reason ADR-0033's sign-out uses), never only the row named. Any of the account's rows names its place, a rotated one included, so a list one refresh old still works |
| 4 | The account **leaves that place's switch group** first (`leaveGroup`, F-0208's order: membership, then sessions). Otherwise any member still signed in there could switch back to it with no credential (F-0207). Getting back in costs a fresh proof there — the same price as F-0208 |
| 5 | On a bot place (`bot:<tenant>:<platform>:<chat>`), the account's **own link to that chat** is deleted too: the chat signs itself back in against it (ADR-0034), so a revoke alone would not end it. A link that chat holds to another account is not touched. Until the person shares their contact there again, that messenger carries no codes or notices for the account (invariant 12) |
| 6 | The caller's own place is refused (`auth.sessionIsCurrent`): leaving it is `logout`, which falls back onto the place's group (ADR-0035) — this operation never does |
| 7 | An impersonated session may list but never end (`SensitiveActionGuard`): ending someone's sessions is theirs to do |
