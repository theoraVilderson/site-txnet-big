---
id: notification
layer: domain
status: active
version: 8
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
| once per period, and how | **this unit**: `POST internal/notifications/retention/claim` | the ledger below; asked before anything is told; its answer carries the user's mute and quiet hours (F-601-m) |
| tell | `EventNoticeSender` -> auth-service `/internal/notify/user` | inbox (a `notification` row through this unit's `create`) and bot, in the user's language — [automation/contract.notices.md](../automation/contract.notices.md) |

## The claim

| Operation | Route | Input | Output | Errors |
|---|---|---|---|---|
| claim a notice for a period | `POST internal/notifications/retention/claim` (`SERVICE_AUTH_TOKEN`) | `{ eventId, userId, grantId: uuid, notice: <outbox type>, period: 1..100 chars }`, strict | `{ claimed: false }`, or `{ claimed: true, deliver: now \| muted }`, or `{ claimed: true, deliver: held, botAt }` (ISO), 200 — "Mute and quiet hours" below | 400 `validation.failed`; 404 on a wrong token |

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

## Mute and quiet hours (F-601-m, spec 9.4, user 2026-09-27)

A user mutes **kinds** of notice and sets one quiet window, in the panel's
settings (panel-web `panel-settings-notifications`; the bot's side is F-319,
over the same row). The claim reads them, so no producer knows they exist.

| Operation | Route | Input | Output | Errors |
|---|---|---|---|---|
| read my settings | `GET notifications/preferences` (gated) | — | `{ muted: kind[], quietHours: { start, end } \| null, timezone }`; no row reads `{ [], null, 'Asia/Tehran' }` | 401; 429 (inbox read bucket) |
| replace them | `PUT notifications/preferences` (gated, open while suspended) | the same, strict; `start`/`end` `HH:MM` and different, `timezone` an IANA zone | what was stored | 400 `validation.failed`; 401; 429 (inbox write bucket) |
| keep a held bot message | `POST internal/notifications/retention/hold` (token) | `{ eventId, grantId, notice, period, tenantId, template, params, botAt }`, strict | `{ held }` | 400; 500 on a `botAt` over a day away |
| take due held messages | `POST internal/notifications/retention/held/take` (token) | `{ limit: 1..500 }` | `{ items: [{ id, tenantId, userId, template, params }] }`, each leased 10 min | 400 |
| mark them told | `POST internal/notifications/retention/held/told` (token) | `{ ids: uuid[1..500] }` | `{ cleared }` | 400 |

| Rule | Why |
|---|---|
| Kinds (shared-core `RETENTION_KIND_OF`): `usage` (50/80/95 %, wallet low, runs out soon), `ending` (7/3/1 days), `connect` (not connected, idle), `reactivated`. `cutoff` — ended, volume or wallet spent, purge soon — is always `now` and has no switch | a user whose service stopped, or whose configs are about to go, must hear it (entitlement `contract.retention.md`) |
| A type missing from the table is told as `cutoff` | a new notice is never silently muted |
| `muted` still writes the ledger row | unmuting never tells a period already past |
| Quiet hours hold the **bot**, never the inbox: `held` means the inbox row now and the bot message at `botAt`, the window's next end in the user's zone, on the minute; a window may wrap midnight | the inbox makes no sound; a morning bot message is still news. Asked 2026-09-27: hold all, silent send, or this — silent send exists on Telegram only |
| The first `hold` for a row stands; a claim by the same event on a row already holding one answers `held` with its `botAt` | a redelivery after the window ends never tells the bot beside the held message |
| A take leases rows 10 min (`FOR UPDATE SKIP LOCKED`); the worker marks each tell per row id, then `told` clears it | two runs never take one row; a run that died between the tell and `told` repeats nothing |
| Minutes from the local clock: a DST jump inside the window moves the release by that hour | Asia/Tehran has kept none since 2022 |

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
| a usage type above, carrying `endNotice`, `endPeriod`, `days` | `serviceUsageAndEndsSoon` (`days` > 1) / `serviceUsageAndEndsWithinADay` (`days` = 1), params `percent`, `remaining` (+ `days`) | billing's metering at the crossing, or entitlement's end sweep, when both are due (F-601-n, below) |
| `entitlement.grant.low_balance` | `serviceWalletLow`, param `remaining` (what the wallet still buys, "819 MB") | billing's block request, after the purchase whose balance buys under 1 GB at a metered Grant's rate; period = the crossing's instant, re-armed by a balance back over it (F-601-g, entitlement `contract.retention.md` "Wallet low") |
| `entitlement.grant.purge_soon` / `.purge_soon_metered` | `servicePurgeSoon` ("renew") / `servicePurgeSoonTopUp` ("top up") | entitlement's purge sweep, a day before a suspended Grant's configs are dropped; period = `suspendedAt` (F-601-j, entitlement `contract.retention.md` "Before purge") |
| `entitlement.grant.ended` / `.volume_spent` / `.wallet_spent` | `serviceEnded` / `serviceVolumeSpent` ("renew") / `serviceWalletSpent` ("top up", never "renew") | billing, in the transaction that stops the Grant: a standing close on a passed end, a prepaid bag's suspension, a metered wallet's; period = the end, or the suspension's instant (F-601-b, entitlement `contract.retention.md` "Cutoff") |
| `entitlement.grant.runs_out_soon` / `.runs_out_within_a_day` | `serviceRunsOutSoon`, params `days`, `remaining` / `serviceRunsOutWithinADay`, param `remaining` | entitlement's hourly sweep, when a prepaid Grant's last 72 h spend what is left of its period within 5 days, before its end; period = the usage period, so it is told once per period (F-602, entitlement `contract.retention.md` "Exhaustion forecast") |
| `entitlement.grant.idle` | `serviceIdle`, optional `supportUrl` | entitlement's hourly sweep, 7 days after the last charge that consumed a byte of an active Grant that can run; period = that `idleCheckAt`, so each idle stretch is told once (F-601-l, entitlement `contract.retention.md` "Idle check-in") |
| `entitlement.grant.reactivated` | `serviceReactivated` | billing, in the transaction that brings a stopped Grant back: a revival by renewal or top-up, or a renewal breaking a standing close; period = the cleared `suspendedAt`, or the close's `closedAt` (F-601-k, entitlement `contract.retention.md` "Active again") |

## Two notices due the same day are one message (F-601-f, F-601-n)

A usage level and a time level due within the same 24 h (a rolling window) are
told as one message: the **usage** event carries the time level (`endNotice`,
`endPeriod`, `days`). The producers decide when (entitlement
`contract.retention.md` "The 24 h hold", user 2026-09-27): a non-urgent level
waits up to 24 h for the other kind, never is told before it is due, and its
words are computed when told. This unit and the consumer only hold the line:

| Rule | Why |
|---|---|
| The consumer claims the usage row first; only if it holds it does it claim the carried row, **for the same event** | a usage notice already told never swallows a time level |
| Both held: the combined text. The carried row refused (told by another event): the usage text alone | the ledger, not the consumer, is the last word on "once" |
| A carried type the usage notice does not accept, or one without `endPeriod` or `days`, throws before any claim | a half-named row would be claimed and never told |

Still two messages within 24 h: two urgent levels (95 % and the last day),
or a held level told when its 24 h ran out and an urgent one soon after — an
urgent notice is never delayed.

## "Your service is ready" is not a retention notice (F-601-h, user 2026-09-27)

The ready moment already has its notice: F-111-d's `purchaseDelivered`, told
once when the Grant turns `active` — which, for a network Grant, is its
configs confirmed at the group's minimum. A second one on
`network.config.confirmed` would say "ready" twice within seconds, before
activation when the minimum is above one, and again for every config a later
panel adds. So there is no ready type in `RETENTION_NOTICES`: billing puts
`servicesUrl` (the tenant's My services page, absent with no panel host) on
`entitlement.grant.delivered`, and the notice ends with it
([automation/contract.outbox.md](../automation/contract.outbox.md)).

## "Being prepared" is not a retention notice either (F-601-i)

A purchase still `pending` 5 minutes on is told once, by the Grant's own
`deliveryDelayedAt` — not by this ledger, which counts per period of a
service the user has. It rides the purchase's own notices (automation
`contract.outbox.md` "A purchase's end, told"), with its tenant owner's alert.

## Not built here

- A mute per Grant, or per channel (bot vs inbox): a kind is muted everywhere.
- The bot's own settings screen: F-319, over the same `notification_preference` row.
- Retention of ledger rows: one per Grant, notice and period, kept.
