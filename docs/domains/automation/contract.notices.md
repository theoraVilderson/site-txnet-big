---
id: automation
layer: domain
status: active
version: 9
updated: 2026-10-06
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
| **A notice's class decides its person channels** (F-601-s, ADR-0097): shared-core `NOTICE_CLASS_OF`, by the template unless the consumer states `class`. `info` (`panelAccepted`, 50 %) is the inbox's alone: `person` joins an inbox-only burst of its window (`noticeBurst(…, window, 'inbox')`, flush `only: 'inbox'`); `important` and `critical` are inbox and bot; a template missing from the table is `critical`. **SMS** (F-601-t): a flush takes its burst's strongest class (a burst entry keeps its stated `class`); `critical`'s bot channel is "bot, else SMS" — SMS only when auth-api's `sent` is empty or every send threw, one marker, so a redelivery asks the bot first; `security` tells the bot with `every` and `sms` under its own marker; no other class sends SMS, nor a class nobody knows (none stated, the name not in the table: the bot as `critical`, no SMS) | no consumer picks channels; a burst of accepted panels is still one row |
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
| `live` only, on each channel the row's `audience` names — `user:<payload.userId>`, `tenant:<payload.tenantId>` (RT-1-b) — with one marker per audience (`live-push`, `live-push-tenant`); never `person` | a Grant with three configs captured would be three bot messages about one purchase; the one person notice, for a panel-side change only, is below (F-027-eo) |
| The body is `{type}` plus exactly the fields the row names — `network.grant.linksCaptured` carries `grantId`, `billing.wallet.changed` nothing (F-111-m) | a payload holds what its producer needed; that is not the browser's |
| A payload without the id an audience needs or a named field, or a type with no row, throws and dead-letters. `tenant.domain.changed` goes to both: the reseller owner and the platform's staff (RT-1-e); `tenant.subscription.renewed`, `tenant.status.changed` and `tenant.subscription.grace_extended` to the owner only, body `{type}` (F-019-c1, -c2, -c3); `identity.access.changed` to the person whose access moved, body `{type}` (AC-1-q); `billing.payment.open_changed` to `tenant:` only, body `{type, paymentId}` — billing writes one row per tenant that lists it (RT-1-j) | whose page it is is never guessed |

## Lines a panel-side change replaced (F-027-eo)

The person half of `network.grant.linksCaptured`, told by `GrantDeliveryConsumer`
(its queue is bound to the type beside the live-push one), consumer
`grant-lines-changed`. User 2026-10-06.

| Rule | Why |
|---|---|
| Told only when the payload's `cause` is `panel`: lines were served for this very uuid and the panel now builds others (network `contract.links.md` rule 7a). `ours` — a first capture, a move, the buyer's own regenerate — and no cause tell nobody | the buyer's app holds the old lines until it updates; their own regenerate they already see |
| Template `serviceLinesChanged`, class `important` (inbox and bot), `person` only, with `grantId` so a combined one names the services | "update the subscription in your app"; the live push stays `LivePushConsumer`'s |
| **Told once the edits settle** (user, 2026-10-06): a `panel` change sets `grantLinesLatest(grantId)` to its event id and publishes a settle check (type `grant.lines.settle`, same id) through its own delay queue (`AUTOMATION_LINES_SETTLE_DELAY_QUEUE`, `AUTOMATION_LINES_SETTLE_MS` = 5 min) back onto this queue; the check tells only while that key still holds its id, under its id's markers | a Grant's configs replaced over a few passes, and an owner's edits in a row, are one notice after the last — when updating the app gets the final lines. A fixed hour bucket (the first cut) left a second edit two minutes later untold |
| A `panel` payload without tenant, user or Grant, or an unreadable `occurredAt`, throws and dead-letters | whose service it is is never guessed |

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

## A new lottery told to its group (F-707-q)

`LotteryAnnouncementConsumer` (`worker-service/src/app/outbox/lottery-announcement.consumer.ts`),
its own queue `AUTOMATION_LOTTERY_ANNOUNCEMENT_QUEUE` on `outbox.engagement.lottery.published`
(one event per publish, in its transaction). User 2026-10-03.

| Rule | Why |
|---|---|
| Members come from billing's `GET internal/billing/engagement/lotteries/:id/audience?after&limit`, 500 a page in user-id order, every page asked while the lottery is open; `open: false` ends the fan-out | a cancel or the close stops it; nobody is told of a lottery they cannot enter |
| Each member: one id per lottery and member (`announcementEventId`, name-based UUID), the ledger's `lottery/claim`, then the sender | a redelivered or half-done fan-out tells nobody twice |
| `opt_in`: `lotteryOpened`, inbox + bot, class `important`, the bot message with Join (`lotteryJoinCallback`); `held` sends the inbox and `hold`s the bot | the user must join before the close |
| `automatic`: `lotteryOpenedAutomatic`, the inbox alone (`info`), never held | it asks nothing of the user |
| `muted` (kind `lottery`) skips; one member failing is counted, the rest told, then the event throws and is delivered again | one bad member never silences a group |
| Its own queue | a group of thousands never holds up a person notice |

## A person told their access moved (AC-1-s)

`AccessNoticeConsumer` (`worker-service/src/app/outbox/access-notice.consumer.ts`),
consumer `access-notice`, its own queue `AUTOMATION_ACCESS_NOTICE_QUEUE` on
`identity.access.changed` (AC-1-q) beside the live-push one. User 2026-10-08.

| Rule | Why |
|---|---|
| `person` only, never `live` | the page already re-read on `LivePushConsumer`'s `{type}` (panel-web AC-1-r); a second frame is a second read |
| One template per cause: `role_set` -> `accessRoleSet` (`role`, the name as written), `role_edited`, `keys_set` (a key given, taken or lifted on the person, AC-1-l) and `group_access` (a group's access, or joining or leaving one, AC-1-m) -> `accessKeysChanged` (`given` / `taken`, keys comma-joined, each only when non-empty), `group_membership_ended` (GR-1-c) -> `accessMembershipEnded` (`group`, the name as written, + `given` / `taken`; no `group` dead-letters), `key_window` (a key's window opened or closed, F-030-a) -> `accessKeyWindow` (`given` / `taken`), `seat_removed` -> `accessSeatRemoved`, `seat_restored` -> `accessSeatRestored`; all `important` (inbox and bot) | the words are auth-service's: `UserNotifier` names each key by its `permissions` label (AC-1-f) in the person's language, else the default one, else the key |
| A `role_edited`, `keys_set`, `group_access`, `group_membership_ended` or `key_window` that gave and took nothing tells no one | a rename, or the same set saved again, moved no access |
| A burst of any of them is one "your access changed N times" (`access.many`) | what is held now is the panel's to show, not a list of edits |
| A cause with no template, a `role_set` with no `role`, or a payload without tenant or user throws and dead-letters | a producer that adds a cause (AC-1-l, AC-1-m, F-030-a, seat expiry) adds its template in the same item, or nobody is told |

