---
id: identity
layer: domain
status: active
version: 24
updated: 2026-09-28
---

# Contract — identity / which messenger a user's notices take

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. The user's choice between Telegram, Bale or both for the
bot side of a notice (F-601-u, ADR-0097 part 2). Which notices take a bot at
all is the notice's class — [notification/contract.retention.md](../notification/contract.retention.md)
"A notice's class".

## Operations

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| read messenger | the caller's session | `{messenger, chosen, linked}` — `messenger` the saved one or `both`, `chosen` false while the column is null, `linked` the platforms with a verified chat | sync | — |
| save messenger | the caller's session, `telegram` \| `bale` \| `both` | the same shape, as stored | sync | a value outside the enum |

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | `user.noticeMessenger` null means **not chosen, and reads as `both`** (user 2026-09-28). No backfill: every existing user is on the default | a blocked bot loses nothing, and a later default can still tell a choice from none |
| 2 | `both`: `UserNotifier` messages each verified chat whose tenant has a bot, **once**; a send that throws is not retried through the other | each bot told once is the whole promise of "both" |
| 3 | A chosen messenger is told **alone**; the other only when that send throws (a blocked bot) or it has no verified chat. Among the rest, linked-last order | the user's pick is honoured, and a notice still arrives |
| 4 | A messenger **not linked yet may be chosen**; rule 3 then tells the other. Nothing refuses it | linking it later needs no second visit to settings |
| 5 | A security notice (`every`, F-601-t) ignores the choice: every verified chat | the owner of the account hears about it wherever they are |
| 6 | Only the caller's own row is read or written, by `claims.sub` | a setting, not an administration |

## Not built here

- Choosing from inside the bot: F-319.

Code: `auth/me/me-messenger.service.ts`, `auth/notify/user-notifier.ts`.
Wire shapes: [auth-api/contract.messenger.md](../../interfaces/auth-api/contract.messenger.md).
