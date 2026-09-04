---
id: catalog
layer: domain
updated: 2026-09-04
---

# Data model — catalog

Source of truth: `txnet-backend/prisma/domains/catalog.prisma` (Postgres schema
`catalog`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| product_category | free-key category (`vpn`, `fake_member`, ...) | `tenantId` nullable | permanent |
| service_plan | plan: billing model, base price / price-per-unit, `attributesJson` | `tenantId` nullable | permanent (deactivate via `isActive`) |
| service_plan_promotion | direct time-boxed discount on a plan | via plan | expires |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| product_category.tenantId, service_plan.tenantId | -> | tenant.tenant.id | tenant-specific catalogue entries |
| service_plan (referenced) | <- | network.config.servicePlanId, billing.coupon_service_scope | provisioning + coupon scope |

## Access rules

Read-mostly for provisioning/checkout; writes via an admin catalogue service.

## Migration notes

None specific. No migration history committed.
