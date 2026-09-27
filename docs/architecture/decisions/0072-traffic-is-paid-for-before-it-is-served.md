---
id: adr-0072
status: active
updated: 2026-09-22
---

# ADR 0072 — traffic is paid for before it is served

- **Status:** accepted; rule 1's writer is network's lease planner since F-027-db (ADR-0093) — the bound stands, billing no longer writes the split
- **Date:** 2026-09-21
- **Affects units:** network, entitlement, billing, catalog

## Context

Catalog §8.5 bills metered traffic **after** it is measured: read the panel's
counter, take the delta, debit the wallet, advance `billedBytes`. Every design
in that family has the same hole, and it is not a bug in the design — it is the
shape of it. We run no software on the customer's server, so between "the user
is consuming" and "we know" there is always a gap:

```
free traffic = (collection interval + enforcement timeout) x line rate
             = (60s + 600s) x 100 Mbit ~ 8 GB ~ $4
```

Tightening the loop shrinks that number and never reaches zero — a 10-second
interval still leaves 125 MB — and it is spent **per user who lets their
balance reach zero**, which is a thing users learn to do on purpose. Multiply
by several configs on several panels and the same wallet funds it N times over.

The user set the requirement on 2026-09-21: *"داخل قسمت pay as go نمی‌خوام یه
صدمه سنت هم ضرر باشه"* — not even a hundredth of a cent. Under post-paid
metering that is unachievable, so the model has to change rather than be tuned.

There is a second, independent problem in §8.5. It accumulates charges in Redis
and flushes "once one cent or 15 minutes accumulates", because one 100 MB
increment is worth less than a cent. But `WalletLedgerService` refuses any
amount finer than two decimal places with `InvalidLedgerAmount` and **never
rounds** (`C-02`, ADR-0002, ADR-0019), so the sub-cent amount §8.5 computes can
never be written. The spec's own `Micro`-denominated arithmetic has no home in
this ledger.

What makes a different model available: **every panel family we sell on, except
one, enforces a per-user data limit itself** — `data_limit` in Marzban and
Marzneshin, `totalGB` in x-ui, `usage_limit_GB` in Hiddify, native quota in
IBSng and Mikrotik UserManager. The enforcement point we were trying to reach
over the network is already sitting next to the traffic.

## Decision

**No byte is served that has not been paid for.**

Before a metered config carries traffic, a **block** of bytes is bought from the
wallet at a whole-cent price, and the panel's own per-user data limit is set to
exactly the bytes that purchase covers:

```
ceiling = billedBytes + purchased headroom
SetClientDataLimit(remoteId, ceiling)
```

As consumption advances, the next block is bought and the ceiling moves ahead.
When the balance cannot fund the next block, the ceiling stays where it is and
**the panel cuts the user off by itself** — with no dependence on our service
being awake, our queue being current, or our loop being on time.

The block is sized **from its price, not from its bytes**: the smallest whole
number of cents covering the target headroom, converted to bytes by integer
division rounding **down**. So every ledger row is a clean two-decimal amount,
and we always sell less than or equal to what was paid for.

**A balance short of the target buys a smaller block, not nothing.** Amended
2026-09-22 (F-027-am) to record what F-027-q built: the largest whole-cent block
the balance can fund is bought, and only a balance under **one cent** is refused.
Stalling a user who still holds 99c is this decision's worst acceptable failure —
the ceiling stays put and the panel cuts them off — arriving early and for no
reason, so a partial block is a purchase and not a refusal. It follows from
pricing the block rather than its bytes: the target is a request, and the cents
available are the answer.

Three rules fall out and are part of this decision:

1. **`Σ ceilings ≤ purchasedBytes`, across every config of a Grant, always.**
   One bag spread over five panels needs one ceiling split five ways, not five
   full ceilings. This is an invariant with a property test, not a tuning.
2. **The panel's own limit is ours to write, and drift in it is a finding.**
   This reverses the usual "set the vendor's limits to infinity" instinct: we
   are still the single quota authority, because we are the only writer of that
   number. A limit *lower* than ours only shortens the user's service and is
   reported; a limit *higher* is a money hole and is overwritten immediately,
   even past the anti-flapping stop.
3. **Unconsumed purchased bytes are credited back** when the Grant closes, as
   an ordinary append-only ledger row.

A panel that cannot enforce a per-user data limit **cannot sell metered
service**. Today that is Mikrotik WireGuard alone.

## Consequences

- Positive: the loss is **zero by construction**, not small by tuning. It does
  not depend on the interval, on our uptime, on queue depth, or on how many
  panels the user holds. The worst failure in every direction is that a user
  **stalls**, never that they are served free traffic.
- Positive: `C-02` is untouched and §8.5's conflict dissolves. Because the block
  is priced in whole cents, no sub-cent amount is ever computed, so the Redis
  accumulator is not needed at all — which also removes a `C-03` surface.
- Positive: **no hold or reservation primitive is needed.** The money is really
  spent, so `wallet-ledger.ts` changes by not one line, and there is no
  `availableBalance` for every other debit path to start respecting.
- Positive: it closes the concurrent-spend race for free. Money spent on
  traffic is gone before the traffic moves, so a purchase made mid-download
  cannot invalidate a ceiling.
- Positive: prepaid and metered become **one mechanism**. A 20 GB package is a
  bag with a fixed ceiling; pay-as-you-go is the same bag topped up
  automatically. One code path, two products.
- Negative / accepted cost: **money leaves the wallet ahead of consumption**, by
  roughly the headroom horizon — on the order of two minutes of that user's own
  spend. It is refunded on close, but it is visibly reserved until then.
- Negative / accepted cost: **the wallet ledger gets a row per block** — at a
  two-minute horizon, hundreds a day for a heavy user, in the same list a person
  reads their top-ups and transfers from. There is no roll-up available, because
  the money moving before the bytes is the decision itself and `balanceAfter` is
  written by the debiting transaction. Settled 2026-09-22 with the user
  (F-027-am) on the read side instead: `/wallet/history` leaves
  `traffic_consumption` out of a page nobody narrowed, and a floor on the
  horizon (F-027-u) bounds the write rate. Sizing blocks larger to write fewer
  rows was rejected — it does not bound the count and it worsens the cost above.
- Negative / accepted cost: **a panel family is excluded from metered sale.**
  Mikrotik WireGuard has no per-peer quota, and accepting an exception for it
  would reopen exactly the hole this decision closes.
- Negative / accepted cost: **we now write to panels during normal operation**,
  where before we only read. That is new load on someone else's server and a
  new way to be rate-limited or banned, which is why the request budget and the
  `throttled_or_blocked` state exist alongside this.
- Negative / accepted cost: **a manual counter reset invalidates a ceiling.** A
  ceiling of 42 GB sitting over a counter someone zeroed is 42 free gigabytes,
  so the convergence loop must rewrite the ceiling in the same pass that detects
  the reset. Without that, a reset button is a way around this decision.
- Negative / accepted cost: a user whose balance cannot fund headroom at their
  line rate gets a stuttering service unless the driver supports per-user rate
  limiting. Stuttering is honest and cheap; it is still worse than smooth.
- What this forecloses: selling metered traffic on any system that cannot be
  told a per-user byte limit, and any future "just bill it afterwards" path for
  a family that is awkward to fence.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Post-paid metering as §8.5 describes it, with a tighter loop | the requirement is zero, and this family reaches zero only in the limit. A 10s interval still leaks 125 MB per user per occurrence, and the occurrence is one the user chooses |
| Post-paid plus a balance floor and an adaptive interval (the earlier plan) | the same family. Both levers shrink the window; neither closes it. They survive in the design, but as protections against *stalling*, where being late costs a few seconds rather than a few dollars |
| A hold / reservation on the wallet | it needs a new primitive, an `availableBalance` every existing debit path must start respecting, and changes to `wallet-ledger.ts`. It buys nothing over spending the money, because the money is spent within minutes either way |
| A ceiling computed from the live balance, with no purchase | no money moves, which is tidier — but the ceiling goes stale the moment the user spends that balance elsewhere, and the gap is exactly what they spent. It trades a guarantee for a smaller hole |
| A second `Micro`-denominated ledger, as catalog §14.5 sketches for tenants | it would carry sub-cent arithmetic honestly, but it makes two ledgers where ADR-0002 deliberately has one, and the user wallet is the one that must reconcile. §14.5's traffic wallet is a tenant-level concern and stays out of this round |
| Round sub-cent remainders up to a cent | overcharging by up to a cent per increment, forever, to avoid arithmetic. It also writes a number to the ledger that is not what was owed |

## Revisit trigger

Any of:

- A panel family we need has no writable per-user data limit and cannot be
  fenced another way. That is a decision to reopen with the user, naming what
  the post-paid alternative would cost on that family specifically.
- The pre-charged headroom draws real complaints — users reading reserved money
  as an overcharge. The lever is the horizon safety factor, and if tuning it is
  not enough the trade is worth restating.
- The write load on customer panels proves unwelcome in practice, past what the
  per-panel request budget can absorb.
