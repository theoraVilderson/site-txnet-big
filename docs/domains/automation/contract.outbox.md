---
id: automation
layer: domain
status: active
version: 6
updated: 2026-09-25
---

# Contract — automation: the transactional outbox

A §10 split of [contract.worker.md](contract.worker.md), which is at its
250-line ceiling. That file is the tick runtime — schedules, jobs, the
dead-letter path. This one is the outbox ADR-0021 decided and F-067-c built,
and it is split off rather than appended because its audience is different:
this is the file a **producing domain** reads when it needs to announce
something, and nothing in it is about ticks.

## What it is for

ADR-0021's failure is specific. A confirmed payment must provision a config
(`billing` -> `network`), credit a commission (`billing` -> `tenant`), deliver
a campaign (`notification`). Call the panel synchronously inside the money
transaction and either the transaction rolls back after the money moved, or
the money moves and no service appears. Publish after the commit instead and
there is a window in which the event is owed and no record says so.

So: **the producing service inserts an `automation.outbox_event` row inside
the same Postgres transaction that writes the ledger**, and `OutboxRelayJob`
publishes the unpublished rows afterwards. The event and the state change that
caused it commit or fail together, which is the whole of ADR-0021.

**Nothing produces yet.** `billing`, `network`, `notification` and `ai` are all
`draft`, so the table has no writer and the relay drains an empty table. That
is why this was cheap to build today and would not have been on the day the
first payment landed.

## How a domain writes one

Inside the transaction, never outside it. There is no service API for this and
there deliberately is not: an API call is a second thing that can fail, and a
second thing that can fail is what the outbox exists to remove.

| column | what goes in it |
|---|---|
| `aggregate` | what it is about — `billing.payment`, `network.config` |
| `aggregateId` | which one |
| `type` | what happened — `payment.confirmed`. **It is the routing key**, see below |
| `payload` | the domain's own shape. Nothing outside the domain types it |
| `occurredAt` | defaulted. When the transaction said it happened, not when it was sent |

The relay owns `publishedAt`, `attempts` and `lastError`. A producer never
writes them and never reads them: whether an event has gone out is not a fact
a producer can act on, because by the time it could ask, the answer has
changed.

## The wire

The routing key is `outbox.<type>` on the exchange the rest of automation
already uses (`AUTOMATION_EXCHANGE`), and `outboxRoutingKey`
(`shared-core/src/lib/automation/outbox.ts`) is the only thing that builds it.
The `outbox.` prefix is not decoration: `automation.tick.#`, `otp.delivery.#`
and `bot.update.<slot>` are already bound on that exchange, and `type` is a
string a domain chooses — one day a domain chooses `bot.update` and its events
start arriving at a bot consumer.

`type` is validated rather than trusted, because it arrives from a database
column and AMQP does not refuse a bad routing key. It matches nothing, for
ever, silently. A `type` that is not a dot-separated path fails the row with
that reason in `lastError` instead.

**Delivery is at-least-once and never exactly-once**, which ADR-0021 says
plainly and this implementation cannot improve on: the relay can publish a row
and lose the process before it stamps `publishedAt`. The row's `id` is the
event id and travels as the AMQP `messageId`, so a consumer dedupes on it
before it parses anything. **A consumer that cannot safely process the same
event twice is a bug in the consumer.**

That is the whole of the consumer-side contract that exists today, and it is
less than ADR-0021 asks for: there is no shared `processed_event` store and no
helper, because there is no consumer to use one. Writing that table now would
mean choosing its shape — per-consumer or shared, in which schema, with what
retention — for callers that do not exist, and the first real consumer is what
should answer it.

## The relay

`outbox_relay` is a third `Job` in `worker-service`, beside `worker_heartbeat`
and `vault_credential_retention` (D-14). No new unit and no new deployable:
one table and one job, next to the runtime that already owns the exchange.
ADR-0021 calls the outbox a new unit; splitting it out later stays cheap while
it is still one of each.

**It needs an `always_on` `bot_schedule`**, exactly like the other two — a job
with no schedule never becomes due. `prisma/seed.js` creates it (2026-09-14).

**Postgres wakes it, so the tick is only the fallback** (F-067-n, ADR-0084
decision 1). Migration `20260925000200_the_outbox_wakes_its_relay` puts a
`FOR EACH STATEMENT` `AFTER INSERT` trigger on `outbox_event` that notifies
`outbox_ready`; `OutboxRelayListener` (`worker-service/src/app/jobs/`) holds
the `LISTEN` on `DATABASE_APP_URL` and runs the same `run()` when woken — an
event is out about a second after its commit (16 ms on dev), not up to one
`AUTOMATION_TICK_INTERVAL_MS`. At most one woken pass runs and one waits
behind it; a burst folds into that one. A pass runs on every (re)connect,
because a notification nobody heard is gone. A woken pass is still a run of
`outbox_relay`, so `isActive = false` stops it (invariant #1), and it records
no `bot_execution_log` row: a failure stays on the row's `lastError`, and the
tick's run is the one that fails loudly.

**Rows are claimed `FOR UPDATE SKIP LOCKED`, `AUTOMATION_OUTBOX_BATCH` at a
time.** Two relays running at once is the expected case, not the pathological
one: ADR-0027 makes redelivery ordinary and a deployment may have several
replicas. `SKIP LOCKED` makes that harmless — each transaction takes a
disjoint batch and neither waits. Without it the second relay blocks on the
first's rows and republishes every one of them the moment it unblocks.

**`publishedAt` is stamped inside the same transaction as the publish, after a
confirmed one** (invariant #10). The two directions are not symmetric, and the
order is chosen for that: a publish that succeeded against a stamp that rolled
back sends the event twice, which the idempotency key covers. A stamp that
committed against a publish that never happened loses the event with the table
asserting it was sent — the exact window the outbox exists to close.

**A failed publish stops the batch and fails the run.** Whatever refused the
row is about the broker, not the row, so working through the rest of the batch
against it buys nothing; the remaining rows keep their place in `occurredAt`
order. The run throws, so `TickConsumer` records `failed` (invariant #3) — a
`success` with a count of zero is indistinguishable from an empty outbox, and
an empty outbox is what a healthy one looks like.

**`lastError` is written after the transaction it describes has rolled back**,
which is the one ordering detail in the relay that is invisible if it is
wrong: written inside, the only record of why the relay is stuck is discarded
along with the failure. It carries the publisher's reason — `nacked`,
`unroutable` or `timeout` — because the message alone does not say which.

**The relay never gives up on a row.** There is no attempt ceiling and no
dead-letter path for the outbox, and that is deliberate: a row that has not
published is not lost, it is in a durable table that is itself the audit trail
of what the system decided to announce. Nothing is gained by moving it
somewhere else, and an event a committed transaction promised is not something
to throw away because nobody was listening yet. What makes the retrying
visible instead is monitoring — see [contract.monitoring.md](contract.monitoring.md).

**Today every publish that happens at all is `unroutable`**, because no domain
binds a queue to `outbox.#` and every publish is `mandatory`. That is the
correct answer rather than a gap: an event announced to nobody is not an event
delivered, and the alternative — a plain publish the broker acks into nothing
— is what invariant #10 exists to forbid.

## The first consumer: the payer notice (F-067-l, ADR-0045)

`PaymentConfirmedConsumer` in `worker-service/src/app/outbox/`, on its own
queue `AUTOMATION_PAYMENT_CONFIRMED_QUEUE` bound to exactly
`outbox.billing.payment.confirmed`, so that type stops being `unroutable` and
every other stays so.

| Rule | Why |
|---|---|
| A `webhook_auto` credit is acked and nothing is sent — **unless the payload's `channel` is `bot`** (F-306-a; absent = `panel`) | a panel payer is on the success page; the notice is for a **late** credit. A bot payer started in a chat and waits there |
| A payload with `shownInChat: true` is acked and nothing is sent, whatever its channel (F-104-m) | billing sets it only on the credit the bot's `paid` relay made, and the bot has already said it in that chat |
| **Dedupe first:** `SET NX` `UnscopedRedisKeys.outboxProcessed('payment-credited-notify', <event id>)`, `RedisTtl.outboxProcessed` (7 days), before any side effect; already set is an ack | at-least-once delivery (ADR-0021) must not tell the payer twice |
| Then `{type:'billing.payment.confirmed', paymentId, amountCredited}` on `user:<userId>` (`RealtimePublisher`), then `POST /api/internal/notify/user` on auth-service with `X-Tenant-Id` = the payload's tenant and template `paymentCredited` | the live half is at most once and cheap; the bot half needs the tenant's bots, which are auth-service's |
| A side effect that throws **deletes the marker** and rethrows: nack, no requeue, dead-letter | the event stays owed instead of being recorded as handled |
| A payload missing its tenant, user, payment, amount or source throws | whose payment it is is never guessed |
| **The relay's schedule is seeded** (2026-09-14): `outbox_relay` is in `SEEDED_SCHEDULES`, `always_on`. A database seeded before that needs `prisma db seed` re-run; unscheduled, the event is never published and nobody is told | ADR-0045 consequences — the operator decided it once, in the seed, rather than per deployment |

## The second consumer: a reversed payment (F-067-m, ADR-0046)

`PaymentReversedConsumer`, on its own queue `AUTOMATION_PAYMENT_REVERSED_QUEUE`
bound to exactly `outbox.billing.payment.reversed`. Both consumers send through
`outbox/user-notice.ts` (`UserNoticeSender`).

| Rule | Why |
|---|---|
| Every reversal is told — there is no source to skip | nobody watches a reversal happen; a payer who paid and got nothing must hear why |
| Its marker is `outboxProcessed('payment-reversed-notify', <event id>)`, never the credited notice's | one payment can carry both events in its life; neither may swallow the other |
| `{type:'billing.payment.reversed', paymentId, amountCredited}` on `user:<userId>`, then template `paymentReversed` with `{amount}` | the panel toast and the bot message; the words are auth-service's, in the user's language |
| Otherwise the first consumer's rules: dedupe before any side effect, marker given back on a throw, a payload without tenant, user, payment or amount throws | ADR-0045 |

## The third consumer: a new inbox row (F-035-b)

`NotificationCreatedConsumer`, on its own queue
`AUTOMATION_NOTIFICATION_CREATED_QUEUE` bound to exactly
`outbox.notification.created`. `notification-service` writes the event in the
transaction that writes the row (`notification/contract.md` "Emits").

| Rule | Why |
|---|---|
| Marker `outboxProcessed('notification-created-live', <event id>)` first; already set is an ack | a redelivery must not add the item to the dropdown twice |
| `{type:'notification.created', notification}` on `user:<userId>`, and nothing else — no bot message | the row is already in the inbox; this only spares an open panel a reload |
| No marker to give back: `RealtimePublisher` never throws | a closed panel reads the row on its next load, so at most once is enough |
| A payload without `userId` or `notification.id` throws | whose row it is is never guessed |

## A connection test's answer, live (F-027-bs)

`PanelTestedConsumer`, queue `AUTOMATION_PANEL_TESTED_QUEUE` bound to exactly
`outbox.network.panel.tested`. The producer is `network-service`
(`network/contract.registration.md` "Every result is announced").

| Rule | Why |
|---|---|
| `{type:'network.panel.tested', panelId, reviewState, fault}` on `tenant:<tenantId>` — the first push on a `tenant:` channel | the systems page is an operator's view, and only a `realtime.tenant.read` holder in that tenant hears it |
| The tenant is the payload's; a payload without `tenantId` or `panelId` throws and dead-letters | the producer names the platform owner for a platform panel; this side never guesses |
| **No marker** | a redelivery is one more re-read of the page; `RealtimePublisher` never throws |

## The tenant consumers: a reseller's renewal (F-019-c)

Both in `outbox/tenant-renewal.consumers.ts`. The producers are tenant's:
`TenantBillingLedger.credit` and `TenantRenewalService`
(`domains/tenant/contract.billing.md` "Subscription renewal").

| Rule | Why |
|---|---|
| `TenantBillingCreditedConsumer`, queue `AUTOMATION_TENANT_BILLING_CREDITED_QUEUE` on `outbox.tenant.billing.credited`: `POST /api/internal/tenant-subscriptions/:tenantId/renew`; **no marker** | the renewal repeats safely; a paid reseller is charged and reactivated at once (user, 2026-09-17) |
| A refusal, an unset seam or an answer without `outcome` throws and dead-letters | the `tenant_subscription_renewal` sweep stands behind a lost event |
| `TenantSubscriptionNoticeConsumer`, queue `AUTOMATION_TENANT_SUBSCRIPTION_NOTICE_QUEUE` on `outbox.tenant.subscription.payment_due` and `.suspended`: template `subscriptionPaymentDue` / `subscriptionSuspended` to `ownerUserId`, marker `outboxProcessed('tenant-subscription-notice', <event id>)`, given back on a throw | the payer notices' rules (ADR-0045); one queue, because both are the same owner's same story |
| `OutboxEventType` is not all realtime: only `RealtimeEventType` is held to `contracts/realtime/events.json` | a tenant event is never pushed to a browser |

## What is not built

- Payer notices, two live pushes and the tenant renewal only; no Postgres idempotency store — ADR-0045 chose
  Redis for the first, and a consumer that moves money must choose again.
- No retention or archive of published rows. ADR-0021 makes the table an audit
  trail; when that stops being worth keeping needs a producer with an opinion.
- No admin surface. `GET /auth/workers/dead-letters` has no outbox twin —
  the alerts in `contract.monitoring.md` are how a person learns something is
  wrong, and the row itself is a `SELECT` away.
