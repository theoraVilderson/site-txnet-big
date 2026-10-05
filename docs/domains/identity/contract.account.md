---
id: identity
layer: domain
status: active
version: 28
updated: 2026-10-05
---

# Contract — identity / a person's own name and password

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. A signed-in person renaming themselves and changing their
password (UX-1-t). Code: `auth-service/src/app/auth/me/me-account.service.ts`.
Wire shapes: [auth-api/contract.account.md](../../interfaces/auth-api/contract.account.md).

## Operations

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| rename myself | the caller's session, `fullName` | `{fullName}` — the caller's own row written | sync | — |
| change my password | the caller's session, `currentPassword`, `newPassword`, `endOtherSessions` | `{otherSessionsEnded: n}` — the hash rewritten; the other places ended when asked | sync | `wrong_password`; `password.containsProfileData` |

## Rules

| # | Rule |
|---|---|
| 1 | `fullName` is held to the register form's rules (trimmed, 2–120); the new password to the register form's too — `strongPasswordSchema`, and never containing the username, the name or any spelling of the phone (as a reset) |
| 2 | The current password is always asked: `passwordHash` is never null, every account is created with one. A wrong one writes nothing and ends nothing |
| 3 | A change is not a reset: **this** place stays signed in, on the session it already has. The other places end only when `endOtherSessions` is true, and then through [contract.sessions.md](contract.sessions.md)'s "end every other place" — switch groups and bot links exactly as rules 3–5 there |
| 4 | Only the caller's own row is read or written. An impersonated session may rename but never change the password (`SensitiveActionGuard`, 403): a credential is the account's own, as ending its sessions is (contract.sessions.md rule 7) |
