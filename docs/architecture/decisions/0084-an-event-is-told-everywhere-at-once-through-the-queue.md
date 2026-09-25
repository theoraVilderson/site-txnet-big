---
id: adr-0084
status: active
updated: 2026-09-25
---

# ADR 0084 — an event is told everywhere, at once, through the queue

- **Status:** accepted
- **Date:** 2026-09-25
- **Affects units:** automation, notification, identity (auth-service notify seam), realtime, network, billing, panel-web

## Context

F-027-bs put a connection test's verdict on `/systems` through the outbox
(ADR-0021). Asked how it should behave, the user (2026-09-25) set three terms
for **every** event, not that one:

1. **At once.** `OutboxRelayJob` runs on the `always_on` tick, so an event
   waits up to `AUTOMATION_TICK_INTERVAL_MS` (60 s) before it is published.
2. **Never lost, and everywhere.** Today a live push is at most once: a page
   that was closed hears nothing, and only the payer notices (ADR-0045) also
   send a bot message. The user wants each notice on every open site, in the
   panel inbox, and from the bot.
3. **Through the queue under load.** A burst of events must not become a burst
   of reads and messages.

## Decision

1. **Postgres wakes the relay.** An `AFTER INSERT` trigger on
   `automation.outbox_event` calls `pg_notify('outbox_ready', '')`, the
   mechanism ADR-0083 chose for `/sub`. `worker-service` holds one `LISTEN`
   connection and runs a relay pass when woken, at most one pass in flight and
   one queued behind it. The tick stays as the fallback. A notification sent
   while nobody listened is lost, so on every (re)connect the worker runs one
   pass. Nothing is published outside the relay: ADR-0021 and invariant #10
   stand unchanged. A woken pass is still a run of `outbox_relay`, so it reads
   the worker's switch (`workerIsRunnable`, invariant #1) before each pass: an
   operator who switched the relay off must not see it run on a wake.
2. **One notice path, three channels.** An event type that tells a person is
   declared once with its audience and its template. `worker-service` sends
   through one `EventNotice` sender, which replaces the per-consumer copies:
   - **live:** the event on `user:<id>` or `tenant:<id>`, to every open device;
   - **inbox:** a row through `notification-service`, which every device reads
     when it next opens (its own `notification.created` push already exists,
     F-035-b);
   - **bot:** the auth-service notify seam (ADR-0045), in the user's language.
   Each channel has its own Redis marker, `outboxProcessed(<consumer>:<channel>, <event id>)`,
   so a redelivery repeats only the channel that failed. A tenant-audience
   event goes to the inbox and bot of the tenant's `ownerUserId`, as the F-019-c
   notices already do.
3. **Bursts are absorbed by the queue and then combined.** Each outbox queue is
   consumed with a bounded prefetch. Inbox and bot notices for one recipient
   and one type are combined over a short window (a Redis list per
   recipient+type, flushed by the first event's delayed job). A burst becomes
   one summary ("12 panels tested"), not twelve messages. The page re-reads on
   a trailing throttle (at most once per 2 s, and the last event always causes
   a read). The live push itself is never combined, because it is cheap and
   the throttle is on the reader.

## Consequences

- Positive: an event is heard in about a second. Polling does not increase,
  because the tick interval is unchanged.
- Positive: a notice survives a closed browser twice, in the inbox and in the
  bot, and a new event type gets all three channels by declaring itself.
- Negative / accepted cost: one long-lived Postgres connection per worker
  replica. A replica woken by an event it does not win only runs an empty
  `SKIP LOCKED` pass.
- Negative / accepted cost: a combined notice arrives up to one window late,
  and only for the inbox and the bot. The live push is not delayed.
- Existing consumers (F-067-l/m, F-035-b, F-019-c) move onto the sender. Their
  markers are renamed, and an event in flight at deploy time may be told twice
  through one channel. This is accepted once and never repeated.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Tick every 1 s | a query every second per replica, forever, even when nothing happened |
| Publish right after commit, outbox as backup | the user ruled it out for F-027-bs, and two paths mean two orders of delivery |
| Tell the bot only when no socket is open (presence) | presence is racy across devices and replicas. A notice missed by that race is lost, which is the failure this ADR exists to prevent |
| Web Push | new infrastructure (keys, service worker, device registry). Not asked for now. It would be a fourth channel on the same sender |

## Revisit trigger

A tenant event that someone other than the owner must receive (for example a
support queue), or a user who wants to turn a channel off. Either needs
per-recipient preferences in `notification`.
