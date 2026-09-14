---
id: entitlement
layer: domain
updated: 2026-09-14
---

# Data model — entitlement

Source of truth (planned, F-026-b): `txnet-backend/prisma/domains/entitlement.prisma`
(Postgres schema `entitlement`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| grant | one entitlement: user, variant, source, status, startsAt/endsAt, billingMode, featureKeys, quotas copied from the variant, sharingPolicy, subscriptionToken, billedBytes, resellerPath | yes (RLS) | permanent |
| quota_adjustment | a signed change to one quota metric of a Grant, with its source and optional expiry | yes (RLS) | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| grant.variantId | -> | catalog.product_variant.id | what was issued |
| grant.userId, grant.tenantId | -> | identity.user, tenant.tenant | whose |
| grant (referenced) | <- | network.config.grantId | a config draws on its Grant's quota (§4.6) |

## Access rules

Written only through the entitlement module in `billing-service` (ADR-0049).

## Migration notes

None yet.
