---
id: automation
layer: domain
status: active
version: 8
updated: 2026-09-28
---

# Contract — automation: telling a person about an event

A §10 split of [contract.outbox.md](contract.outbox.md), which was at its
ceiling when F-067-p added the burst rules. That file says which events are
consumed and who each one tells; this one says **how** a person is told, which
is the same for every consumer: `EventNoticeSender`
(`worker-service/src/app/outbox/event-notice.ts`), ADR-0084 decisions 2 and 3.

## One notice path: live, inbox, bot (F-067-o)

| Rule | Why |
|---|---|
| A notice declares `live` (`{channel: user:<id> \| tenant:<id>, body}`) and/or `person` (`{tenantId, userId, template, params}`); a tenant-audience notice's person is the payload's `ownerUserId` | the producer names who is told; this side never resolves it |
| `live` is pushed at once; `person` joins its burst (below), and the flush makes one `POST /api/internal/notify/user` per channel, `inbox` then `bot` | the words and the user's language stay auth-service's |
| **Each step has its own marker**, `outboxProcessed('<consumer>:<step>', <event id>)` — `live` and `person` per event, `inbox` and `bot` per flush (consumer `notice-burst`, the flush id) — `SET NX` before it and given back if it throws | a redelivery repeats only the step that failed, never a landed push, bot message or inbox row |
| **A notice's class decides its person channels** (F-601-s, ADR-0097): shared-core `NOTICE_CLASS_OF`, by the template unless the consumer states `class`. `info` (`panelAccepted`, 50 %) is the inbox's alone: `person` joins an inbox-only burst of its window (`noticeBurst(…, window, 'inbox')`, flush `only: 'inbox'`); `important` and `critical` are inbox and bot; a template missing from the table is `critical` | no consumer picks channels; a burst of accepted panels is still one row |
| A failed step does not stop the others; the sender rethrows after all ran, and the event or the flush dead-letters | one broken seam does not starve the rest |
| Markers were renamed from `'<consumer>'` to `'<consumer>:<channel>'` at F-067-o | an event in flight at that deploy may be told twice through one channel, once (ADR-0084 consequences) |
| At F-067-p the per-event `inbox` / `bot` markers became one `person` marker. An event holding either old marker is **not** joined: the channel it still owes is told alone, under its old marker (`owedBeforeBursts`) | ADR-0084 accepts a rename once, at F-067-o. Dead code once those markers expire, 7 days after deploy |

## Live-only pushes (F-111-l)

`LivePushConsumer`, queue `AUTOMATION_LIVE_PUSH_QUEUE`, consumer `live-push`:
the events an open page re-reads on and nobody is told about. A type is a row
in `LIVE_PUSH_FIELDS` plus its binding in `BrokerService`, and
`OUTBOX_EVENT_BINDER` names worker-service for it.

| Rule | Why |
|---|---|
| `live` only, on `user:<payload.userId>`; never `person` | a Grant with three configs captured would be three bot messages about one purchase |
| The body is `{type}` plus exactly the fields the row names — `network.grant.linksCaptured` carries `grantId`, `billing.wallet.changed` nothing (F-111-m) | a payload holds what its producer needed; that is not the browser's |
| A payload without `userId` or a named field, or a type with no row, throws and dead-letters | whose page it is is never guessed |

## A burst is told once (F-067-p, ADR-0084 decision 3)

A burst of twelve panel tests is one message, "12 panels accepted", not
twelve. The live push is never combined: it is cheap, and the page throttles
its own re-read (`panel-web/contract.systems.md` rule 2).

| Rule | Why |
|---|---|
| **A burst is one recipient, one tenant, one template.** `person` is `HSET` into `noticeBurst(tenantId, userId, template)`, field = event id | a redelivered event is counted once; two templates never merge into a sentence neither has |
| **The first event of a burst schedules its flush.** One script adds the event and `SET NX`es `noticeBurstScheduled(…)` to a new flush id; the call that took it publishes the flush to `AUTOMATION_NOTICE_DELAY_QUEUE` with `expiration` = `AUTOMATION_NOTICE_WINDOW_MS` (10 s) | one flush per burst however many replicas take its events |
| A flush that could not be published frees the flag and throws; the event's `person` marker is given back | the redelivery schedules it again. The flag's own TTL (window + 60 s) frees a burst whose flush died with its process |
| **The delay is the broker's**: the delay queue has no consumer and dead-letters onto `notice.burst.flush`, bound by `AUTOMATION_NOTICE_FLUSH_QUEUE`; `NoticeFlushConsumer` tells it | a scheduled flush survives a restart. One window per queue, so a queue's head always expires first |
| **The hour lane** (F-601-p): an event sent with `window: 'hour'` — a patient retention notice — joins `noticeBurst(…, 'hour')`, and its flush (`window: 'hour'`) waits `AUTOMATION_RETENTION_WINDOW_MS` (1 h) in `AUTOMATION_NOTICE_HOUR_DELAY_QUEUE`, onto the same flush key. A held notice's inbox row (F-601-q) is a third lane, `noticeBurst(…, 'hour', 'inbox')`, whose flush carries `only: 'inbox'` and tells that channel alone | the same template's 10 s burst is a different one; a 1 h message in the 10 s queue would hold every flush behind it |
| **The flush takes the burst once.** One script renames the hash to `noticeBurstBatch(flushId)` (7 days) and clears the flag only if it still holds this flush's id | an event after the take opens the next burst. A redelivered flush re-reads its own batch, never a newer one |
| One event: the template with its own params. More: the template with `count` and no params — auth-service's `…Many` / `…ManyTitle` text | a summary cannot name twelve panels. `auth-api/contract.md` `/internal/notify/user` |
| **A burst of services is named** (F-601-p): an entry is stored as `{ params, grantId? }` (the older bare params still read); a combined flush whose every entry has a Grant asks billing's `grants/names` once and sends `services` beside `count`, one per entry, each with the buyer's name for it (`label`, F-307-x). A failed lookup tells without it | "3 of your services end within a week" says which three (notification `contract.retention.md`) |
| A flush with an empty batch sends nothing | a second flush of an already-taken burst is harmless |
| **Each outbox queue has its own channel at `AUTOMATION_OUTBOX_PREFETCH` (8)**, like the bot-update queues | `prefetch` is per channel here. On the shared one a burst of one type took the ticks' slots and every other type's |

**Accepted cost:** an inbox row or bot message arrives up to one window late,
even when it was alone (ADR-0084 consequences). A payer on the success page is
told by the live push, which is not delayed.

## Retention notices (F-601-a)

`RetentionNoticeConsumer`, queue `AUTOMATION_RETENTION_NOTICE_QUEUE` bound to
every type in `RETENTION_NOTICES` (`outbox/retention-notices.ts`), consumer
`retention-notice`. The producer side and the ledger are
[notification/contract.retention.md](../notification/contract.retention.md).

| Rule | Why |
|---|---|
| `person` only — template and the params the type's row names — to `userId`'s inbox and bot; no live push | the inbox row brings its own (F-035-b) |
| First `POST notification internal/notifications/retention/claim`; `claimed: false` acks and tells nobody | once per Grant period, whoever emitted twice (notification invariant 14) |
| A payload without tenant, user, Grant, `period` or a named param, or a type with no row, throws **before** the claim | a claimed period whose notice never went out is lost until the next period |
| A row's `optional` params (`supportUrl`, F-601-c) are passed when the payload has them, and their absence is never a throw | a tenant with no support link still tells the notice |
| A refused claim or an unset `NOTIFICATION_API_BASE_URL` throws and dead-letters | the same event id claims again on a replay |
| The claim answers how (F-601-m): `muted` acks and tells nobody; `held` first `POST …/retention/hold` (the words and `botAt`), then tells the **inbox only** — a patient one through the inbox-only hour lane (F-601-q); a claim with no `deliver` throws before anything is told | the user's mute and quiet hours are the ledger's, one rule for every producer; the bot message is `retention_held_notice`'s ([contract.worker.md](contract.worker.md)) |
| The consumer states the **types'** class, never the template's (50 % and 80 % share `serviceUsageThreshold`); a combined notice takes the stronger class of its two types, and is held when either claim answers `held` (F-601-s) | 50 % carrying "3 days left" still reaches the bot, after the quiet hours |
| A usage level muted while its carried time level (F-601-f) is not: the time level is told alone, in its own row's words | a muted kind never swallows one that is not |
| `only: [...]` on `EventNoticeSender.send` tells just those person channels, each on its own marker, never joined to a burst — except `only: ['inbox']` with `window: 'hour'` (a held patient notice, F-601-q), which joins the inbox-only hour lane under its `inbox` marker | a burst's flush would tell the bot at once, inside the quiet hours; an inbox-only one tells no bot |

