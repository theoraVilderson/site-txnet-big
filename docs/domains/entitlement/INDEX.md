---
id: entitlement
layer: domain
status: draft
version: 10
keywords: [grant, entitlement, access, quota, quota adjustment, subscription token, free grant, feature key, purge, purge clock, suspended grant, panel seat, revive, top-up restores service, delivery, paid grant, being prepared, refund undelivered purchase, renewal, renew grant, carry-over, traffic debt, debt forgiven, not connected yet, never connected, unused service, activated, usage threshold, volume running low, 80 percent used, usage period, service ending soon, days left, expiry reminder, 7 days before end]
source: [txnet-backend/prisma/domains/entitlement.prisma, txnet-backend/prisma/domains/migrations/20260914001600_entitlement_grant/**, txnet-backend/prisma/domains/migrations/20260921000600_a_grant_buys_its_bytes_before_it_serves_them/**, txnet-backend/prisma/domains/migrations/20260925000700_grant_delivery_clock/**, txnet-backend/prisma/domains/migrations/20260925001300_a_subscription_link_is_kept/**, txnet-backend/prisma/domains/migrations/20260926000400_an_unlimited_grant_says_so/**, txnet-backend/prisma/domains/migrations/20260927001100_a_grant_asks_if_it_connected/**, txnet-backend/prisma/domains/migrations/20260927001200_a_grant_counts_its_usage_period/**, txnet-backend/prisma/domains/migrations/20260927001300_a_grant_is_told_its_end_is_near/**, txnet-backend/prisma/domains/migrations/20260927001500_a_metered_grant_is_told_its_wallet_is_low/**, txnet-backend/prisma/domains/migrations/20260927001700_a_grant_is_told_before_its_purge/**, txnet-backend/billing-service/src/app/entitlement/**]
owns_tables: [grant, quota_adjustment]
depends_on: [catalog, identity, tenant]
updated: 2026-09-27
---

# Entitlement

**Responsibility (one sentence):** Grants — the single answer to "may this
user use X" — with their one-way lifecycle, quotas and quota adjustments.
**Explicitly NOT responsible for:** what is for sale or its price (`catalog`),
taking money (`billing`), provisioning a config for a Grant (`network`).

Runs as a module inside `billing-service` (ADR-0049). Spec:
`python3 tools/spec.py --section 4.4` (and 4.5, 4.6).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing entitlement from outside |
| [contract.retention.md](contract.retention.md) | a retention notice: not connected, usage or time thresholds (F-601) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-27 | v9 -> **v10** (additive): the 24 h hold — `usageNoticeLevel` + `usageNoticeSince`; 50 / 80 % and 7 / 3 days wait up to 24 h for the other kind and are told as one event, 95 % and the last day never wait (F-601-n, replaces F-601-f's look-ahead) |
| 2026-09-27 | v8 -> **v9** (additive): time thresholds — `endNoticeFor` + `endNoticeAt`, `end-due` asked hourly by `grant_end_notice`, emits `entitlement.grant.ends_in_7d` / `_3d` / `_1d` (F-601-e); the retention rules move to [contract.retention.md](contract.retention.md) |
| 2026-09-27 | v7 -> **v8** (additive): usage thresholds — `usagePeriodFromBytes` + `usagePeriodStartedAt`, opened by a renewal that adds bytes; metering emits `entitlement.grant.usage_50` / `_80` / `_95` (F-601-d). See [contract.md](contract.md) |
| 2026-09-27 | v6 -> **v7** (additive): "not connected yet?" — `activatedAt` + `unusedCheckAt`, `unused-due` asked hourly by `grant_unused_notice`, emits `entitlement.grant.not_connected` / `.still_not_connected` (F-601-c). See [contract.md](contract.md) |
| 2026-09-27 | v5 -> **v6**: `renewGrant` — a renewal is `Quota += X` on the same Grant, a debt up to 2 GiB forgiven, a larger one carried (F-027-dg). See [contract.md](contract.md) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
