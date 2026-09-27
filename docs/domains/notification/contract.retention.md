---
id: notification
layer: domain
status: active
version: 7
updated: 2026-09-27
---

# Contract — notification: retention notices, once per Grant period

A §10 split of [contract.md](contract.md), which is at its ceiling. This is the
file a **producing domain** reads before it emits a retention event (F-601,
spec 9.5), and the file a later F-601 row reads before it adds one.

## Who does what (F-601-a, user 2026-09-27)

Spec 9.2: a domain emits, it never tells anyone. Retention notices travel the
one notice path of ADR-0084 — not a second one inside `notification-service`
(the user chose this over the row's first wording, 2026-09-27):

| Step | Where | What |
|---|---|---|
| emit | the producing domain (entitlement, billing, network) | an outbox row (ADR-0021) in the transaction that saw the moment |
| route | `worker-service` `RetentionNoticeConsumer`, queue `AUTOMATION_RETENTION_NOTICE_QUEUE` | bound to every type in `RETENTION_NOTICES` (`outbox/retention-notices.ts`) |
| once per period | **this unit**: `POST internal/notifications/retention/claim` | the ledger below; asked before anything is told |
| tell | `EventNoticeSender` -> auth-service `/internal/notify/user` | inbox (a `notification` row through this unit's `create`) and bot, in the user's language — [automation/contract.notices.md](../automation/contract.notices.md) |

## The claim

| Operation | Route | Input | Output | Errors |
|---|---|---|---|---|
| claim a notice for a period | `POST internal/notifications/retention/claim` (`SERVICE_AUTH_TOKEN`) | `{ eventId, userId, grantId: uuid, notice: <outbox type>, period: 1..100 chars }`, strict | `{ claimed }`, 200 | 400 `validation.failed`; 404 on a wrong token |

- One `retention_notice` row per `(grantId, notice, period)`. The first event
  to claim it writes it and is answered `claimed: true`.
- **The row is held by that event** (invariant 14): the same `eventId`
  claiming again is `true` — a send that failed after its claim is told on the
  redelivery — and any other event is `false`, which the consumer acks
  without telling anyone.
- A claim that was answered `true` and whose notice then never reached anyone
  is lost for the period. The consumer therefore validates the whole payload
  **before** it claims, and a failure after the claim dead-letters the event
  (F-067-d), where a replay under the same id is still owed.
- Not rate-limited, like every internal seam here.

## What a producer writes

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | the event key, `<domain>.grant.<moment>`; a row in `RETENTION_NOTICES` with its auth-service template, and `worker-service` in `OUTBOX_EVENT_BINDER` |
| `tenantId`, `userId`, `grantId` | yes | whose Grant — never looked up by the consumer |
| `period` | yes | the producer's name for the Grant's current period. **A renewal opens a new one** (the backlog row's rule), so the same notice may be told again after it; e.g. the period's start instant, ISO |
| the params its row names | yes | strings, passed to the template as they are |
| the row's `optional` params | no | passed only when present — `supportUrl`, the tenant's support link, which auth-service turns into the notice's last line |

Each producing row (F-601-b..l) adds its type, its template and its producer
together:

| Type | Template | Producer |
|---|---|---|
| `entitlement.grant.not_connected` / `.still_not_connected` | `serviceNotConnected` / `serviceStillNotConnected`, optional `supportUrl` | entitlement, 24 h / 72 h after activation with nothing consumed; period = `activatedAt` (F-601-c) |
| `entitlement.grant.usage_50` / `_80` / `_95` | `serviceUsageThreshold`, params `percent`, `remaining` | billing's metering, on the charge that crosses the level of a prepaid Grant's usage period; period = `usagePeriodStartedAt ?? startsAt` (F-601-d, entitlement `contract.retention.md`) |
| `entitlement.grant.ends_in_7d` / `_3d` / `_1d` | `serviceEndsSoon` (7, 3) / `serviceEndsWithinADay` (1), param `days` | entitlement's hourly sweep, 7 / 3 / 1 day(s) before `endsAt`; period = `endsAt`, so a renewal opens a new one (F-601-e) |
| a usage type above, carrying `endNotice`, `endPeriod`, `days` | `serviceUsageAndEndsSoon` (`days` > 1) / `serviceUsageAndEndsWithinADay` (`days` = 1), params `percent`, `remaining` (+ `days`) | billing's metering, when a time level falls due within 24 h of the crossing (F-601-f, below) |
| `entitlement.grant.ended` / `.volume_spent` / `.wallet_spent` | `serviceEnded` / `serviceVolumeSpent` ("renew") / `serviceWalletSpent` ("top up", never "renew") | billing, in the transaction that stops the Grant: a standing close on a passed end, a prepaid bag's suspension, a metered wallet's; period = the end, or the suspension's instant (F-601-b, entitlement `contract.retention.md` "Cutoff") |

## Two notices due the same day are one message (F-601-f, user 2026-09-27)

A usage level is told the moment a charge crosses it; a time level is
predictable. So the **usage** event carries the time level due within the next
24 h — a rolling window, never a calendar day — and the user hears both at
once (the user chose this over holding the time notice, 2026-09-27).

| Rule | Why |
|---|---|
| The producer names the level with `endNoticeAhead` (shared-core `end-notice-levels.ts`): the nearest level due by now + 24 h and not before activation; `endPeriod` = `endsAt`, the sweep's period for it | the same row the sweep's event would claim, by the sweep's own rules |
| The consumer claims the usage row first; only if it holds it does it claim the carried row, **for the same event** | a usage notice already told never swallows a time level |
| Both held: the combined text. The carried row refused (the sweep told it): the usage text alone | the ledger, not a timer, decides; nothing is held back |
| The sweep's own event for that level later finds its row held, and tells nothing | invariant 14; one message, not two |
| A carried type the usage notice does not accept, or one without `endPeriod` or `days`, throws before any claim | a half-named row would be claimed and never told |

The one case still told twice: a time level told first, then a usage level
crossed within the same 24 h — a crossing cannot be foreseen.

## Not built here

- Muting and quiet hours (F-601-m): they will be read at the claim, which is
  why the ledger is this unit's — ADR-0084's revisit trigger. The three
  cutoff types above (F-601-b) are never muted nor held for quiet hours.
- Retention of ledger rows: one per Grant, notice and period, kept.
