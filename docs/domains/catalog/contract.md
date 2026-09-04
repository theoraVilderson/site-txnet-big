---
id: catalog
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — catalog

**DRAFT — schema only.** From `txnet-backend/prisma/domains/catalog.prisma`.

## TL;DR

Category keys are free strings (add a category without a deploy).
`tenantId = null` = platform-shared item; a set `tenantId` = a reseller's own
category/plan/pricing. All prices are base currency (ADR-0002).

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| list categories | tenantId? | active categories (shared + tenant's own) | sync | — |
| list plans | categoryId, tenantId? | active `service_plan`s + active promotions | sync | — |
| get effective price | servicePlanId, quantity? | base-currency amount after active promotion | sync | plan inactive |
| upsert category / plan / promotion | admin payload | row | sync | — |

## Emits (events)

None.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | `tenantId` for tenant-scoped categories/plans/pricing | tenant catalog unavailable; shared catalog still works |

## Guarantees (intended)

- `billingModel` in {`pay_as_you_go`, `fixed_package`, `one_time`};
  `pricePerUnit` + `unitLabel` only meaningful for `pay_as_you_go`.
- `attributesJson` holds category-specific fields (e.g. `{"platform":"instagram"}`).
- A plan with `tenantId` set overrides the shared plan for that tenant only.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
