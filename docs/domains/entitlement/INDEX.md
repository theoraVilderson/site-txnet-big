---
id: entitlement
layer: domain
status: draft
version: 5
keywords: [grant, entitlement, access, quota, quota adjustment, subscription token, free grant, feature key, purge, purge clock, suspended grant, panel seat, revive, top-up restores service, delivery, paid grant, being prepared, refund undelivered purchase]
source: [txnet-backend/prisma/domains/entitlement.prisma, txnet-backend/prisma/domains/migrations/20260914001600_entitlement_grant/**, txnet-backend/prisma/domains/migrations/20260921000600_a_grant_buys_its_bytes_before_it_serves_them/**, txnet-backend/prisma/domains/migrations/20260925000700_grant_delivery_clock/**, txnet-backend/prisma/domains/migrations/20260925001300_a_subscription_link_is_kept/**, txnet-backend/billing-service/src/app/entitlement/**]
owns_tables: [grant, quota_adjustment]
depends_on: [catalog, identity, tenant]
updated: 2026-09-25
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
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-14 | Unit created, draft (D-34, ADR-0049) — no schema or code yet |
| 2026-09-25 | v4 -> **v5**: the subscription token is kept sealed beside its hash and `subscriptionTokenFor` answers it again; invariant #6 reversed (F-114-e-a, D-43, ADR-0085). See [contract.md](contract.md) |
| 2026-09-25 | v3 -> **v4**: delivery of a paid Grant — `deliver-due` over the internal seam, asked every minute by `grant_delivery`; emits `entitlement.grant.delivered` / `.refunded` (F-111-d, spec §5.8 step 3). See [contract.md](contract.md) |
| 2026-09-23 | v2 -> **v3**: a top-up revives what it funds — `reviveFundedGrants`, called by `WalletCreditService` on every user-wallet credit, guarded by `walletCanBuy` (F-027-ap, ADR-0079). See [contract.md](contract.md) |
| 2026-09-23 | v1 -> **v2**: the purge clock and the way back — `purge-due` over the internal seam, asked hourly by `grant_config_purge`, plus `reviveOnTopUp` (F-027-y, ADR-0075). See [contract.md](contract.md) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
