---
id: adr-0096
status: active
updated: 2026-09-27
---

# ADR 0096 — a prepaid Grant the planner closed is suspended

- **Status:** accepted
- **Date:** 2026-09-27
- **Affects units:** entitlement (invariant 12, `contract.md`), network (`contract.lease.md` rule 24, `internal/leaseplan`), automation (`contract.outbox.md`), billing (`traffic/exhaustion.ts`)
- **Decision row:** `F-027-dw`; the user chose "suspend for real" over "only show it spent" on 2026-09-27
- **Amends:** ADR-0075 (exhaustion suspends only a metered Grant)

## Context
A prepaid Grant that used its whole allowance was cut off on every panel: the
lease planner closes it and the convergence pass disables its configs
(F-027-dd). Billing never learned of it, though. The Grant stayed `active`
and its configs stayed `desiredEnabled`, so My services, the bot, the admin
and `/sub` all showed a working service that no longer worked. On
2026-09-27 three 1 GiB Grants on dev showed `active` with 1.08–1.7 GiB used.
ADR-0075's suspension ran only for metered Grants, when a block purchase was
refused.

## Decision
1. **The planner's close is the one rule for "spent".** It closes a Grant
   when what the panels served reaches Quota (`purchasedBytes`). Billing
   does not decide the same thing again from `consumedBytes`, because two
   rules would disagree for the length of the panels' lag.
2. **The close is announced in the statement that writes it**
   (`network.grant.closed`, ADR-0021), payload `{userId, grantId,
   quotaBytes}`. It carries no `tenantId`, because ADR-0094 does not list
   that column and billing finds the tenant from the Grant. A reopen is not
   announced.
3. **Billing suspends only a prepaid, non-unlimited, `active` Grant whose
   close still stands on its Quota.** It locks the Grant row, then reads
   the close row, so a renewal that raised Quota first gets `reopened`.
   A renewal that waits on the lock then finds the Grant suspended and
   revives it (`renewal.ts`). The suspension is ADR-0075's: `suspended`
   with `quota_exhausted` and the purge clock, and every config
   `desiredEnabled = false`.
4. A metered Grant's close is ignored here. Its end is still the refused
   block (ADR-0075), because money in the wallet means a closed bag is not
   the end.

## Consequences
- Every reader sees the same state as the panels, within one outbox relay.
- A spent prepaid Grant now runs a purge clock: if it is not renewed within
  `purgeAfterDays`, its clients are removed from the panels. A renewal
  rebuilds them from desired state (ADR-0075).
- A wallet top-up does not revive a prepaid Grant (`revival.ts` scans
  metered Grants only). A renewal does.
- Closes written before this change announced nothing. On dev the three were
  settled once by calling billing's `grants/:id/closed`.
