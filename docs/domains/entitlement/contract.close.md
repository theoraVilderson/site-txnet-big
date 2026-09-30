---
id: entitlement
layer: domain
status: draft
version: 25
updated: 2026-09-30
---

# Contract — entitlement: the close stage (F-118-x)

A §10 split of [contract.md](contract.md), which is at its ceiling. The third
stage after ADR-0075's suspension and purge (D-59 (b)): a suspended Grant that
nobody renewed is closed for good, and the money it still ties up is given back.

## When

`GrantCloseStageService.closeDue(now)` (`entitlement/close-stage.ts`) closes every
`suspended` Grant whose `suspendedAt + purge window + close window <= now`.

- The close window is its own setting because a renewal or top-up still revives
  a purged Grant (ADR-0075); this is where that ends. `tenant.closeAfterDays`
  (default **30**, user 2026-09-30) with `grant.closeAfterDays` as a per-Grant
  override (user 2026-09-30), resolved `coalesce(grant, tenant)`, read live.
- **Either window at `0` means never.** A tenant that never purges keeps its
  dead clients, and so keeps the Grant. Resolved in the scan, not after it — a
  never row would fill every bounded batch (`purge.ts`, data-model "The purge clock").
- **A frozen Grant is never closed** (`statusReason = admin_frozen`), as it is
  never purged. Every other suspension reason is closed.
- Batch size is `GRANT_PURGE_BATCH_SIZE`, oldest `suspendedAt` first; the scan is
  cross-tenant and each close runs in its tenant (`deposit-expiry.service.ts`).

## What a close does — one transaction per Grant

| Step | Rule |
|---|---|
| 1. status | `suspended -> expired`, `statusReason = closed_after_purge` (`CLOSED_AFTER_PURGE`), guarded on the status, reason and `suspendedAt` the scan read. A Grant revived since then is left alone and nothing below runs. `suspendedAt` stays as history. |
| 2. configs | any config still `desiredRemote = present` (purge not run yet) goes `absent`, disabled, `pending` — as the admin delete does. No row is deleted (invariant 13). |
| 3. VPN remainder | `RemainderCreditService.settle` with `stoppedAt = null` — a metered bag's unserved bytes, a prepaid Grant's unused share (billing [contract.traffic-block.md](../../domains/billing/contract.traffic-block.md)). A refusal that means "nothing to give back" (`nothing_to_credit`, `nothing_paid`, `not_measurable`, `grant_not_metered`, `rate_not_priceable`) still closes. |
| 4. other meters | `settleAtClose(tx, {grantId, refund: true})` — billing [contract.usage-rating.md](../../domains/billing/contract.usage-rating.md). Always `refund`: the user did nothing wrong, the service ran out and was not renewed. |
| 5. wholesale | `wholesaleAtClose`, both ways (F-118-y) — a reseller's unserved wholesale bytes back on its billing wallet; bytes a platform panel served past what it bought charged up to its balance, the rest logged ([contract.package-wholesale.md](contract.package-wholesale.md) rule 5, billing [contract.traffic-block.md](../../domains/billing/contract.traffic-block.md) wholesale rule 3). |

Step 1 comes first because the remainder credit refuses a Grant that is not
closed (`grant_not_closed`). `cursor_moved` (a block bought between read and
write), or any other error, rolls that one Grant back — counted `failed`, asked
again next tick — and the rest of the batch goes on.

`expired` is terminal (`grant_status_one_way`): after the close a renewal or a
top-up reaches nothing, and the user buys a new Grant with the remainder already
in their wallet. The close tells nobody; no event is emitted.

## The clock

No clock of its own: the hourly `purge-due` call (`grant_config_purge`,
[contract.md](contract.md) "Purge and restore") runs it last, after the purge
and its notices, and answers `closed` and `closeFailed` beside its counts.
