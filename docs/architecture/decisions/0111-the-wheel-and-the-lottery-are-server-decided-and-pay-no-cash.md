---
id: adr-0111
status: accepted
updated: 2026-10-03
---

# ADR 0111 — the wheel and the lottery are server-decided, pay no cash, and a draw is checkable without an outside server

- **Status:** accepted, not built (F-707-a … F-707-p, F-036-a)
- **Date:** 2026-10-03. The user chose every point below in conversation,
  each the recommended option.
- **Affects units:** engagement, billing, entitlement, fraud, governance,
  automation, panel-web, bot-app
- **Builds on:** ADR-0049 (separate units in one process), ADR-0110 (personal
  coupon), D-11 (fingerprint recipe and thresholds), F-114-j (user groups)

## Context

The catalog's F-707 ("Lucky wheel and interactive mechanics") and the
`engagement` schema describe a daily wheel with a hard daily cap. The user
asked for the wheel and for a lottery among a user group, both built so they
cannot be gamed and do not turn into a liability later. Three abuses decide
the shape: one person spinning or entering with many accounts; a prize that
can be moved between accounts and so harvested; an operator steering a draw
by editing the group before it closes.

## Decision

1. **A module of `billing-service`, tables in the `engagement` schema.** A
   spin or a won prize is recorded and delivered (Grant bytes, days, a
   coupon, a Grant) in one transaction, so a prize is never given twice nor
   lost. Not chosen: an `engagement-service` — every prize becomes a
   cross-service call needing an outbox, retries and compensation. The
   separate schema keeps a later split cheap.
2. **No cash, ever.** A prize is bonus GB on the user's active Grant, extra
   days, a personal single-use coupon (ADR-0110's clone path), a free Grant
   of a variant, or nothing. None can be transferred. Not chosen:
   `wallet_credit` — wallet transfer lets many fake accounts pool their
   winnings into one; a separate non-transferable promo balance is a second
   money shape for little gain. `SpinPrizeType.wallet_credit` is never used.
3. **The device fingerprint first.** F-036-a records D-11's fingerprint
   before any spin; a spin or an entry from a fingerprint behind 5 or more
   accounts in 30 days is refused (D-11's "blocks free grants"). Not chosen:
   launching on a purchase requirement alone.
4. **The server decides the wheel.** Eligibility is gathered fresh and frozen
   into the attempt; the pick is `crypto.randomInt` over the version's
   weights; the client only animates to the slot it is told. The odds are
   shown to users. A config edit is a new version from the next tenant day
   (TZ-1); each attempt names its version. The day's cost and each prize's
   stock are per-day counter rows locked `FOR UPDATE` — no nightly reset job,
   no midnight race; a pick over the cap or out of stock becomes `empty`.
   Spins per day are a database unique, not a read-then-write.
5. **A draw is checkable, and needs no outside server.** At close the
   entrant list is frozen (ticket numbers, its hash) and only then is the
   seed made — `crypto.randomBytes(32)`, stored encrypted (ADR-0022). In the
   same one-time job the winners and the reserves are a permutation from
   HMAC-SHA256(seed, listHash) by Fisher–Yates with rejection sampling; the
   seed, the list hash and the result are published together. The algorithm
   lives in `shared-core` so the verify page runs the same code. A draw
   happens once (database unique); no route lets an admin start, repeat or
   seed it. After publish the prizes and times are frozen; cancelling needs
   a public reason. The seed does not exist while the list can still change,
   so a tenant's admin cannot steer the result by editing the group.
   **What this does not cover:** someone with access to the platform's
   servers or database. Not chosen (user, 2026-10-03): a future Bitcoin
   block hash as public entropy — it closes that gap but needs an outside
   server, which the user ruled out.
6. **Entry is free; a ticket is never sold.** One entry per user, from the
   group's user members (automatic) or those who opt in. A platform group's
   reseller members do not enter in this version.

## Consequences

- `spin_wheel_prize.currentDayAwardedCount` and its nightly reset are
  replaced by per-day counter rows (F-707-a).
- `spin_wheel_attempt.deviceFingerprintId` stays required: F-036-a lands
  first.
- Each tenant runs its own wheel and lotteries; a prize's cost to a reseller
  follows the same path as an admin's gift (F-311-l).

## Amendments

- **2026-10-03 (user), point 5.** The first version drew from a future
  Bitcoin block hash fetched from two public explorers. The user ruled out
  any outside server; point 5 now draws from a seed made after the freeze.
