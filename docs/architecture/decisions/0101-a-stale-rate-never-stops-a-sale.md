---
id: adr-0101
status: accepted
updated: 2026-09-28
---

# ADR 0101 — a stale rate never stops a sale; a person pins one instead

- **Status:** accepted
- **Date:** 2026-09-28 (user, D-52, D-53; rows F-0607-a, F-0607-b, F-0608-a)
- **Affects units:** currency, billing, panel-web
- **Supersedes:** the catalog's F-0607 ladder beyond 60 minutes (staticRate,
  then the gateway disabled)

## Context

F-0607 (catalog 6.3) stops using the last rate after 60 minutes: a gateway
falls to its `staticRate`, or is disabled. Its reasoning is that refusing a
sale costs one sale while a wrong rate costs an unbounded amount. The user
(2026-09-28) wants the opposite during an outage: every rate ever accepted is
kept, the latest is used however old, and an admin — the platform, or a tenant
for its own books — can pin a fixed rate for the emergency.

## Decision

1. **Every accepted rate is kept, and the latest is always usable.** Rows are
   append-only and `fx:rate:{code}` has no TTL (already so, F-0606-a). No age
   makes a currency unpriceable.
2. **Age is shown, not enforced.** Under 15 minutes normal; from 15 minutes the
   rate is `stale`: the gateway is marked `degraded`, admins are alerted, and
   the panel shows a banner with the rate's age and a link to pin one.
3. **The order a reader takes**: a live manual pin (a tenant's, inside that
   tenant's books only — ADR-0098 part 9 — else the platform's), then the
   latest accepted rate of any age, then a gateway's `staticRate` only when the
   currency has never had a rate.
4. **The last download is a suggestion, never a rate** (D-53). Readings the
   worker took but did not accept (a shortfall, a refused move) stay in the run
   log; the manual-pin form shows the latest of them beside the last accepted
   rate, and an admin may pin it with one action. Nothing uses them unasked:
   they are exactly the readings the median and the gate did not trust.
5. **A currency without any rate still cannot be chosen** (F-116-a,
   unchanged).
6. **A pin may have no end** (amended 2026-09-28, user, F-116-n). A person
   may fix a rate as their own price, not only for an emergency: `hours: null`
   pins until someone ends it, and the panel offers that first. The cost is
   the one accepted above, without a clock: a forgotten pin sells at its rate
   while the market moves. The picker marks every pinned currency, and one
   click ends a pin.

## Consequences

- Accepted cost: while no one pins a rate, a fast market sells at an old one.
  The alert (`CurrencyFxRateStale`), the degraded gateway and the banner exist
  so that someone does.
- F-0607-a becomes a pure age classifier with no "no rate" rung for a currency
  that has one; F-0607-b marks and alerts, and disables nothing.
- A pinned rate is not the worker's baseline: the deviation gate still compares
  a new reading with the last *accepted* discovered rate, so a pin does not make
  the market look like it jumped.

## Revisit trigger

A loss from selling at a stale rate that a pin would not have prevented in
time, or a gateway whose provider requires a fresh rate.
