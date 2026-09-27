---
id: adr-0093
status: active
updated: 2026-09-27
---

# ADR 0093 — the lease planner lives beside the poll, in network-service

- **Status:** accepted
- **Date:** 2026-09-27
- **Affects units:** network (`contract.ceiling.md`, `contract.hot-loop.md`, `contract.reserve.md`), billing (`traffic/ceiling-allocator.ts`, `traffic/horizon.ts`, `traffic/hot-loop.*`)
- **Decision row:** asked 2026-09-27; the user answered "replace the planner". Rows `F-027-cw`..`F-027-dn`
- **Supersedes in part:** ADR-0072 rule 1 (the split is billing's), ADR-0092 (the hot loop's re-split is called by the delta stream). Both stood until `F-027-db` flipped the writer, 2026-09-27.

## Context
The split of a Grant's bag across its configs is decided in `billing-service`
(`CeilingAllocatorService`, `horizon.ts`) and carried to the panel by
`network-service`. Every sample the split needs crosses RabbitMQ first, and
the split has no model of a panel's counter tick, a calibrated enforcement lag,
or a write that has not landed yet. The live 1 GiB tests of 2026-09-26
(F-027-cm..cv) were each one of those gaps.

The user supplied `quotaengine` (`quotaengine.zip`, Go, no dependencies): a
pure planner (`quota.Account.Plan`) with a simulator, a property test of the
invariant `Used + Σ Hold + Σ rate·Lag ≤ Quota` over 20 000 random states, and
a fleet run (600 accounts, 8 panels: p95 overshoot +0.37 %, invariant never
broken). Its `SPEC.md` (Persian) lists thirty weaknesses and their fixes.

## Decision
1. The `quota` package moves into `network-service`, unchanged, and becomes the
   only code that decides a config's ceiling. `network-service` already owns
   the poll, the drivers, the budget and drift; those stay and feed it.
2. `billing-service` keeps the money: `purchasedBytes`, the wallet, the metered
   block purchase and the reserve's affordability. It hands the planner one
   figure per Grant, `Quota`, and stops writing `allocatedCeilingBytes`.
3. The planner runs in **shadow** first (plans, logs, no writes) beside the
   current allocator, and takes over only when the shadow's numbers are read
   on dev (`F-027-da`). Two writers of one ceiling are never live together.
4. `quotaengine`'s own adapters, `engine/` and `schema.sql` are reference only.
   Its tables map onto `network.panel` / `network.config`; no parallel schema.

## Consequences
- One brain, one writer of a ceiling, in the process that sees the counter.
- The metered hot loop turns around: the planner asks billing for a block when
  `tEnd < Horizon`, instead of billing guessing from a delta (`F-027-dc`).
- `SPEC.md` is Persian, so it is vendored beside the code as a reference, not
  as a doc (C-01); contracts written from it are English.
- Revisit if the shadow run disagrees with the current split by more than the
  simulator's p95 on live panels: the model is wrong somewhere, not the panel.

## Amendment 2026-09-27 — the cutover (F-027-db)
Asked while building the cutover; the user took the recommendation both times.
- **A config no panel has read gets its first share from the planner**, not
  from billing at creation. A woken turn plans the Grants of configs with no
  ceiling before its convergence step, so a purchase is still created in one
  turn, and there is one writer. The cheaper answer — billing writes the first
  share only — keeps two writers splitting one bag.
- **`walletBackedCeilingBytes` is the share itself until F-027-dc.** Billing
  refreshed it in the split it no longer writes; a stale wallet figure would
  extend a panel over money that may be gone at exit. A metered user loses
  the exit extension until the reserve joins Quota.
- **No guard band on the planner's figure.** Its invariant already holds
  rate × Lag; a band on top pays the lag twice and leaves a panel enforcing a
  figure the planner never wrote, which never reads as a landed write. The
  band stays on the shutdown extension only.
