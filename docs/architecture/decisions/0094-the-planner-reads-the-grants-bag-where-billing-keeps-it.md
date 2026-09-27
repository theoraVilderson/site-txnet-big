---
id: adr-0094
status: active
updated: 2026-09-27
---

# ADR 0094 — the planner reads a Grant's bag where billing keeps it

- **Status:** accepted
- **Date:** 2026-09-27
- **Affects units:** network (`contract.lease.md`, `network-service/internal/leaseplan`, `internal/db/schema.go`)
- **Decision row:** asked while building `F-027-cy`; the user answered "read it directly" and "Used from the counters" on 2026-09-27
- **Amends:** ADR-0071 ("`pgx` access to `network.*` and nothing else")

## Context
ADR-0093 moves the split of a Grant's bag into `network-service`, and the
planner needs two figures every pass: Quota (what was bought) and Used (what
was served). Quota lives on `entitlement.grant.purchasedBytes`, which ADR-0071
puts out of this service's reach. Its other routes were a copy kept in sync by
events, which is the second copy ADR-0093 rule 4 refuses and which lags at the
end of a bag, and an HTTP call to billing every pass, which ties collection to
billing being up.

## Decision
1. `network-service` may **read** the columns listed in `db.ForeignColumns`
   (`entitlement.grant`: `id`, `status`, `purchasedBytes`, `endsAt`,
   `trafficUnlimited`), and nothing else outside `network.*`. The boot
   assertion checks them the same way it checks `network.*`. It writes none of
   them.
2. Used is **not** `grant.consumedBytes`. It is the sum of the lifetime
   counters (`config_counter_state`) of every config of the Grant, retired
   configs included. It is current as of the pass that has just run, where
   billing's figure trails by the broker. It also counts bytes that were
   quarantined, which errs in the safe direction.
3. A column added to that list is a change to this ADR, not a line in the code.

## Consequences
- The planner's inputs are always current, and there is still one copy of each.
- A rename on `entitlement.grant` stops the service at boot rather than
  planning on a null.
- Configs on a push (session) panel are not in `config_counter_state`, so
  their bytes are missing from Used until the planner covers push panels.
