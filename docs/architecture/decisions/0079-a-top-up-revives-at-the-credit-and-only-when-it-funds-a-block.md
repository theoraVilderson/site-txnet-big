---
id: adr-0079
status: active
updated: 2026-09-23
---

# ADR 0079 — a top-up revives at the credit, and only when it funds a block

- **Status:** accepted
- **Date:** 2026-09-23
- **Affects units:** entitlement, billing, network

## Context

ADR-0075 says a top-up returns a suspended Grant to `active` from either
stage. F-027-y built the mechanism — `reviveOnTopUp` in
`entitlement/purge.ts` — and shipped it **with no caller**, because nothing
decided which event counts as the top-up. `entitlement/open-questions.md`
carried that as its own row for one session.

Three candidates were put to the user (2026-09-23):

- the wallet credit that lands the money, in the same transaction;
- the hot loop's next pass, when it finds the wallet no longer short;
- neither, until the hot loop's own channel (`network/open-questions.md`) is
  decided, and then both together.

The second is where the suspension is decided (`traffic/exhaustion.ts`), which
makes it the symmetric-looking answer. It is not the available one: the hot
loop has no caller either (F-027-u), so hanging the revive off it would mean a
user who pays waits for a process that nothing starts. It would also mean the
revive is late by construction — a pass interval, at best.

## Decision

**A top-up revives at the credit.** Every credit to a *user's* wallet inside
`billing-service` goes through one place, `WalletCreditService.credit`, which
appends the ledger row and then revives that user's Grants in the same
transaction. The balance and the service coming back commit or roll back
together, for the same reason `WalletLedgerService` takes the caller's `tx`
rather than opening one: a credit that is visible while the service is still
off is a support ticket.

**Only a credit that funds a block revives.** The revival re-uses
`walletCanBuy` — the exact predicate `suspendIfExhausted` suspended on — so
the revive is the suspension's mirror rather than a second, looser rule. A
credit too small to buy one byte changes nothing.

The guard's job is that the two rules cannot disagree. A revive written as
"any credit revives" is a second rule about money, and the day one of the two
is changed — a minimum block size, a different rounding — they drift, and the
symptom is a Grant that revives and is re-suspended on the next pass with its
purge clock reset each time, because `suspendedAt` **is** that clock and
`reviveOnTopUp` clears it.

How much that scenario is worth is worth stating honestly, because the obvious
version of it is not the real risk. `cachedBalance` is `Decimal(18, 2)`, and
`sizeBlock` floors a target to one cent, so in practice **any** positive
balance funds a block at any sane rate: a user topping up a cent at a time
gets a cent's worth of traffic each time and is not exploiting anything. What
the guard actually catches is the degenerate end — a balance still at zero
after a credit that went elsewhere, and a rate no arithmetic can price
(`block_below_one_byte`), where reviving would turn a catalog fault into a
user whose service flaps for ever.

**Four call sites, one wrapper.** The user-wallet credits are the gateway
settlement, the fully-couponed free top-up, a gift redemption and the
remainder credit at a Grant's close. They call the wrapper rather than
`WalletLedgerService` directly, and `entitlement/revival.spec.ts` fails if a
fifth is added that does not — it allows a class to **debit** the ledger (the
block purchase does, and a debit revives nothing) and refuses a credit. A refund from one Grant reviving another is
deliberate: money is money, and the `walletCanBuy` guard is what judges it.

`WalletLedgerService` itself is **not** the hook. It lives in `shared-core`
(ADR-0061) and is also written by `tenant-service`'s reseller purchase, which
has no business importing entitlement — and the reseller billing wallet
(`TenantBillingLedger`) is a different ledger that must not revive anything.

## Consequences

- Positive: a user who pays has service back in the same transaction, with no
  process needing to be running for it to happen. This is the one part of
  ADR-0075's promise that was not reachable before.
- Positive: the purge clock is safe from the flapping above, and the revive
  and the suspend are provably the same predicate rather than two rules that
  agree today.
- Positive: `reviveOnTopUp` stops being dead code, which was F-027-y's one
  loose end.
- Negative / accepted cost: four call sites now carry a responsibility beyond
  writing a ledger row, and a fifth will be added one day by someone who has
  not read this. The coverage spec is what catches that, and it is a test
  rather than a type, so it catches it at CI rather than at compile time.
- Negative / accepted cost: a revived Grant has an empty bag until something
  buys it a block, and what buys it is the hot loop — still without a caller
  (F-027-u). So a revived user is `active` with configs `present` and
  `desiredEnabled`, and **no ceiling yet**. That is strictly better than
  suspended, and it is not the full promise until F-027-u's channel exists.
- What this forecloses: reviving from a timer or a sweep. If a later row wants
  one — say, to catch a Grant whose rate changed rather than whose wallet did
  — it is a second trigger for the same function, not a replacement for this.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Revive in the hot loop's next pass | it is where the suspension is decided, but it has no caller either (F-027-u), so a paying user would wait on a process nothing starts — and would wait a pass interval even once it does |
| Revive inside `WalletLedgerService` | it is `shared-core` and is written by `tenant-service` too (ADR-0061); entitlement cannot be imported there, and the reseller billing wallet must not revive a user's Grant |
| Revive every suspended Grant, whatever the amount | it makes the revive a second rule about money beside the suspend's, free to drift from it. It also revives a Grant whose rate cannot be priced at all, whose service then flaps for ever on a catalog fault — with the purge clock reset each time |
| Revive only on `payment_gateway` credits | a gift and a remainder credit are money in the same wallet; excluding them would make the rule about the funding route rather than about whether the user can pay |
| Wait for F-027-u and decide both together | it couples a decision that is ready to a decision that is not, and leaves `reviveOnTopUp` dead in the meantime |

## Revisit trigger

Either of:

- F-027-u's channel is decided. The revive's "and then a block is bought"
  half becomes reachable, and whether the revival should buy one itself —
  rather than wait for the next pass — is worth asking then.
- A credit reason is added that should *not* revive. Today every user-wallet
  credit should; the wrapper is one place to add the exception, and this table
  is where the reason goes.
