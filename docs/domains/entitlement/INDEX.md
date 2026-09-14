---
id: entitlement
layer: domain
status: draft
version: 1
keywords: [grant, entitlement, access, quota, quota adjustment, subscription token, free grant, feature key]
source: [txnet-backend/prisma/domains/entitlement.prisma, txnet-backend/prisma/domains/migrations/20260914001600_entitlement_grant/**, txnet-backend/billing-service/src/app/entitlement/**]
owns_tables: [grant, quota_adjustment]
depends_on: [catalog, identity, tenant]
updated: 2026-09-14
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

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
