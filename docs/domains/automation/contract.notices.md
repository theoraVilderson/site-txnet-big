---
id: automation
layer: domain
status: active
version: 8
updated: 2026-09-25
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
| A failed step does not stop the others; the sender rethrows after all ran, and the event or the flush dead-letters | one broken seam does not starve the rest |
| Markers were renamed from `'<consumer>'` to `'<consumer>:<channel>'` at F-067-o | an event in flight at that deploy may be told twice through one channel, once (ADR-0084 consequences) |
| At F-067-p the per-event `inbox` / `bot` markers became one `person` marker | an event dead-lettered before that deploy with one channel owed is told on both when replayed. See ADR-0084 consequences |

## A burst is told once (F-067-p, ADR-0084 decision 3)

A burst of twelve panel tests is one message, "12 panels accepted", not
twelve. The live push is never combined: it is cheap, and the page throttles
its own re-read (`panel-web/contract.systems.md` rule 2).

| Rule | Why |
|---|---|
| **A burst is one recipient, one tenant, one template.** `person` is `HSET` into `noticeBurst(tenantId, userId, template)`, field = event id | a redelivered event is counted once; two templates never merge into a sentence neither has |
| **The first event of a burst schedules its flush.** One script adds the event and `SET NX`es `noticeBurstScheduled(…)` to a new flush id; the call that took it publishes the flush to `AUTOMATION_NOTICE_DELAY_QUEUE` with `expiration` = `AUTOMATION_NOTICE_WINDOW_MS` (10 s) | one flush per burst however many replicas take its events |
| A flush that could not be published frees the flag and throws; the event's `person` marker is given back | the redelivery schedules it again. The flag's own TTL (window + 60 s) frees a burst whose flush died with its process |
| **The delay is the broker's**: the delay queue has no consumer and dead-letters onto `notice.burst.flush`, bound by `AUTOMATION_NOTICE_FLUSH_QUEUE`; `NoticeFlushConsumer` tells it | a scheduled flush survives a restart. One window for all, so the queue's head always expires first |
| **The flush takes the burst once.** One script renames the hash to `noticeBurstBatch(flushId)` (7 days) and clears the flag only if it still holds this flush's id | an event after the take opens the next burst. A redelivered flush re-reads its own batch, never a newer one |
| One event: the template with its own params. More: the template with `count` and no params — auth-service's `…Many` / `…ManyTitle` text | a summary cannot name twelve panels. `auth-api/contract.md` `/internal/notify/user` |
| A flush with an empty batch sends nothing | a second flush of an already-taken burst is harmless |
| **Each outbox queue has its own channel at `AUTOMATION_OUTBOX_PREFETCH` (8)**, like the bot-update queues | `prefetch` is per channel here. On the shared one a burst of one type took the ticks' slots and every other type's |

**Accepted cost:** an inbox row or bot message arrives up to one window late,
even when it was alone (ADR-0084 consequences). A payer on the success page is
told by the live push, which is not delayed.
