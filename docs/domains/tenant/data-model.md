---
id: tenant
layer: domain
updated: 2026-09-04
---

# Data model — tenant

Source of truth: `txnet-backend/prisma/domains/tenant.prisma` (Postgres schema
`tenant`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| tenant | reseller/platform-owner record | self | soft-delete |
| tenant_branding | logo, colours, support contacts, default language | yes | with tenant (cascade) |
| tenant_domain | subdomain / custom domain + verification | yes | with tenant |
| tenant_feature_package | plans the platform sells to resellers | no (catalog of packages) | permanent |
| tenant_feature_entitlement | which feature keys are on for a tenant | yes | until revoked/expired |
| tenant_staff_member | reseller's internal team (own RBAC, separate from identity.role) | yes | — |
| tenant_billing_wallet | what the tenant owes the platform (cache) | yes | with tenant |
| tenant_billing_transaction | append-only ledger of tenant<->platform charges | yes | permanent |
| tenant_usage_meter | metered usage rollups for pay-as-you-go | yes | permanent |
| tenant_gateway_config / tenant_sms_config / tenant_bot_integration | BYO integration credentials (encrypted) | yes | with tenant |
| tenant_restriction | brand-level usage caps | yes | until inactive |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| tenant.ownerUserId, tenant_staff_member.userId | -> | identity.user.id | a tenant is owned/staffed by identities |
| tenant_gateway_config.providerName / gatewayCategory | -> | billing enums | reuse of the payment-provider taxonomy |

## Access rules

Planned: only a tenant-admin service writes these; end-user-facing services read
branding/entitlements through a resolver, never the raw tables.

## Migration notes

`platform_owner` uniqueness, partial unique indexes on domains, and RLS are
"section 99" manual SQL — not applied.
