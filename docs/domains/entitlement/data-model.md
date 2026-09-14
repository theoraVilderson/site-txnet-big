---
id: entitlement
layer: domain
updated: 2026-09-14
---

# Data model — entitlement

Source of truth: `txnet-backend/prisma/domains/entitlement.prisma` (Postgres
schema `entitlement`), migration `20260914001600_entitlement_grant`.

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| grant | one entitlement: user, variant, `source` + `sourceReferenceId`, `status`, `startsAt`/`endsAt`, `billingMode`, `featureKeys`, `quotas` copied from the variant, `sharingPolicy`, `subscriptionTokenHash`, `billedBytes`, `resellerPath` | yes, strict RLS | permanent |
| quota_adjustment | a signed `delta` on one `metric` of a Grant, with its `source`, optional `capPercent` and `expiresAt`; append-only | yes, strict RLS | permanent |

`grant` is a reserved word: SQL quotes it (`entitlement."grant"`).

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| grant.userId | -> | identity."user".id | whose |
| grant.variantId | -> | catalog.product_variant.id | what was issued (null for a `migration` Grant) |
| grant (referenced) | <- | network.config.grantId | a config draws on its Grant's quota (§4.6) |

## Access rules

Written only through the entitlement module in `billing-service` (ADR-0049).
A link lookup hashes the arriving token and reads by
`grant_subscriptionTokenHash_key`; the token itself is never stored.

## Migration notes

`20260914001600` creates the schema, refuses to run over `network.config` rows,
and makes `config.grantId` NOT NULL. `resellerPath` is TEXT until reseller nodes
(`ltree`, F-901) exist.
