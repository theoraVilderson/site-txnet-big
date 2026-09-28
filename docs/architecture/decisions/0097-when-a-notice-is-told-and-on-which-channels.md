---
id: adr-0097
status: active
updated: 2026-09-28
---

# ADR 0097 — when an end notice is told, and which channels a notice takes

- **Status:** accepted
- **Date:** 2026-09-28
- **Affects units:** entitlement (`contract.retention.md`, F-601-e's levels), notification (`contract.retention.md`, the claim), automation (`contract.notices.md`, `EventNoticeSender`)
- **Decision rows:** `F-601-r` (part 1), `F-601-s` (part 2; its SMS is `F-601-t` and the chosen messenger `F-601-u`, split 2026-09-28); the user approved both on 2026-09-28
- **Amends:** F-601-e's fixed 7 / 3 / 1-day levels

## Context
1. A 7-, 3- or 1-day service was told "7 / 3 / 1 days left" the minute it
   was activated. The rule "a level due before activation passes untold" was
   written, but its bound was inclusive (`>=`), and an N-day service's N-day
   level falls exactly on its activation. A plain `>` still leaves a 5-day
   service told "3 days left" two days after purchase, and a renewal to
   8 days told "7 days left" the next day. Services of any length (4, 13,
   16 days) are sold, so a fixed ladder needs a rule for when a level is news.
2. No one place said which channels a notice takes. Retention notices went
   to the inbox and the bot, campaigns to the one channel they chose, and SMS
   only to campaigns. Every new notice would otherwise pick its own channels.

## Decision — part 1: an end notice is told only when it is news (F-601-r)
1. **Span.** The time from when the current end was set to that end.
   "Set" means issue, or the latest write that moved `endsAt`
   (purchase renewal, admin days added or removed). A new Grant column holds
   that moment. At issue it is `startsAt`, not delivery: a purchase delivered
   minutes later would otherwise fall under 14 days and lose its 7-day level
   (F-601-r, 2026-09-28). The rule that no level due before activation is told
   still applies. Older rows were backfilled from their last renewal or
   duration change, else `startsAt`.
2. **A level is told only if the end is nearer than the start.** A level of
   L days is told only when L ≤ span / 2. Before that point the user still
   knows how long the service has left, because they chose it recently.
3. **The ladder stays 7, 3, 1 days.** A notice more than a week ahead is not
   actionable, and one less than a day ahead leaves no time to renew.
4. **Every span of 6 h or more has a last call.** When the span is under
   2 days, the last call is one notice at span / 4 before the end (a 1-day
   service: 6 h). It is told as `GRANT_ENDS_IN_1D`, so no new type or text is
   needed. A span under 6 h gets no time notice, only `ended`.
5. **The last call is never held.** It is already urgent under F-601-n.

| Span | Told |
|---|---|
| 1 day | 6 h before |
| 2–5 days | 1 day before |
| 6–13 days | 3 days and 1 day before |
| 14 days and more | 7, 3 and 1 days before |

## Decision — part 2: a notice's class decides its channels (F-601-s)
A notice's class is found by asking these questions in order. The first
"yes" is the class:

1. Is it the direct answer to what the user just did, while they are looking
   at it? That is a **response**.
2. Could someone other than the user have acted on the account (sign-in,
   password, phone or email change)? That is **security**.
3. Has a loss happened or become certain (service stopped, configs about to
   be purged, a person decided something about the service)? That is
   **critical**.
4. Must the user act soon to avoid a loss, or to get what they paid for
   (ending soon, 80 / 95 %, low wallet, not connected)? That is **important**.
5. Anything else is **info**.

| Class | Channels | Mutable | Quiet hours |
|---|---|---|---|
| response | the requesting session only; not stored | — | — |
| security | every linked channel, plus SMS | no | ignored |
| critical | inbox + primary messenger; SMS only when no bot reached them | no | ignored |
| important | inbox + primary messenger | by kind (F-601-m) | bot held to the window's end |
| info | inbox only, live on every open panel | by kind | — |

- **Primary messenger.** The user chooses Telegram, Bale or both (F-601-u).
  If they have not chosen, it is both: every linked bot is told (user
  2026-09-28, amending "never both" of the same day). With one choice, a
  failed send (for example, the bot is blocked) goes to the other bot; with
  both, each bot is sent once and neither retries through the other.
- **An all-clear follows its alarm.** A notice that ends a critical state
  ("active again") takes that state's channels. Its mute switch stays as
  F-601-m made it.
- **Campaigns are outside the classes.** A campaign's sender picks its
  channel, and its recipients may opt out.
- **One table decides.** Each notice type maps to a class in shared-core,
  beside `RETENTION_KIND_OF`. A producer states the type only. A type missing
  from the table is critical, the same way a missing kind is `cutoff`.
- **Current kinds:** `cutoff` is critical; `ending`, `usage` except 50 %,
  and `connect` are important; 50 % is info; `reactivated` follows its alarm.
- **SMS** uses the line `SmsLineResolver` picks for the tenant (F-035-i-a).

## Consequences
- Short services stop being told their length back to them. A Grant gets
  one column, written wherever `endsAt` is written.
- 50 % usage stops reaching the bot.
- A notice type's channels become a one-row change, and no producer knows
  about channels.
- SMS now costs money outside campaigns. That spend is bounded by security
  events and critical notices that reached no bot.
