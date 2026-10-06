---
id: adr-0121
status: accepted
updated: 2026-10-06
---

# ADR 0121 — a page hears queued work over the socket, and never polls for it

- **Status:** accepted
- **Date:** 2026-10-06
- **Affects units:** panel-web, realtime, automation, network, billing, tenant, support, identity

## Context

The user (2026-10-06): work that runs in a queue must reach the page at once,
and from now on every place that needs a live update gets it over the socket.

The transport already exists and is not the gap: one socket per client
(ADR-0030, ADR-0031), Redis fan-out across replicas (`realtime/contract.fanout.md`),
the outbox woken by `pg_notify` and told through one `EventNotice` sender
(ADR-0084), and `LivePushConsumer` for events only an open page needs. Grant,
wallet, payment, notification and panel-test events already ride it.

The gap is coverage. A survey on 2026-10-06 found two kinds of page that still
learn about queued work late:

- **Pollers** — `PaymentPendingView` (10 s), `BulkByFilter` (10 s),
  `SupportInboxView` (60 s), `useMenuBadges` (60 s, beside a subscription),
  `useBotLink` (2.5 s, before sign-in), `useLocaleVersion`.
- **Manual reload** — a reseller domain stuck on `verifying` until someone
  clicks re-read; a panel drain or removal whose progress `/systems` shows only
  after another event or a click.

Each was built when its producer had no event, and nothing stopped the next
page from doing the same.

## Decision

1. **A page never polls the server for state that someone else's work
   changes** — a queue consumer, a worker tick, another service. It subscribes
   and re-reads. A timer under `site-pwa/src/app` or `site-pwa/src/hooks` is
   allowed only as a clock (`setNow`, `setSeconds`), as something the page
   *sends* (a presence beat), or with a `live-exempt: <reason>` comment on the
   same line. `C-14` checks it; an existing poller stays listed in the check's
   `except` until its row lands.
2. **The producer owes the event.** A job, consumer or service that changes
   something a page shows writes an outbox event in the same transaction
   (ADR-0021). Only a page needs it → a `LIVE_PUSH_FIELDS` row. A person is
   told → an `EventNotice` declaration (ADR-0084), whose live channel already
   reaches the page. A process with no outbox (`auth-service` OTP,
   `support-service`) publishes to the fan-out directly, as today.
3. **The event names the record, not its new state.** The body is `type` plus
   the ids the page needs to know whether to re-read; the page re-reads the
   API, which stays the one source of truth. A figure rides along only where
   the re-read would be the cost being avoided (`entitlement.grant.usage`,
   F-307-t).
4. **The audience is a channel that already has a rule.** `user:<id>` for a
   person's own records; `tenant:<id>` (`realtime.tenant.read`) for an
   operator's views — bulk jobs, domains, panels, the support inbox.
   `LivePushConsumer` gains the tenant audience. No new family without a rule
   in `realtime/contract.channels.md`; before sign-in a channel is
   proof-authorized, as `otp:` is (ADR-0031).
5. **One consumer hook.** `useLiveReread(channel, types, reread)` subscribes,
   filters by type, re-reads on a trailing throttle (`LIVE_REREAD_MS`), and
   re-reads on `onMissed`. No page hand-rolls subscribe-and-throttle again; the
   five that do move onto it.
6. **The socket is sooner, never the only way.** A page still reads on mount
   (`panel-web/contract.realtime.md`, D-15). A socket that is down costs
   freshness, not correctness.

## Consequences

- Positive: a queued job's result is on the page in about a second (ADR-0084's
  wake), with no request until something happened.
- Positive: a new page cannot reintroduce a poller without either a
  `live-exempt` reason in review or a failing check.
- Negative / accepted cost: every new producer of visible state is one outbox
  type and one routing row more. That is the cost ADR-0084 already accepted
  per notice.
- Negative / accepted cost: `C-14` sees `setInterval`, not a `setTimeout` that
  re-arms itself. Review catches that shape.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Shorter poll intervals | a request per page per interval forever, from every open tab, for the common case where nothing changed |
| Server-Sent Events beside the socket | a second transport, a second auth path through `forward-auth`, and the socket already multiplexes |
| Push the full new state in the event | two sources of truth; a missed event leaves the page wrong rather than late, and tenancy filtering would move into every producer |
| A rule in prose only | that is what produced the pollers above |
