---
id: tenant
layer: domain
status: active
version: 2
keywords: [tenant, reseller, white-label, branding, domain, entitlements, tenant billing, host, hostname, custom domain, which tenant, tenant resolution, default tenant]
source:
  - txnet-backend/prisma/domains/tenant.prisma
  - txnet-backend/auth-service/src/app/tenant/**
owns_tables: [tenant, tenant_branding, tenant_domain, tenant_feature_package, tenant_feature_entitlement, tenant_staff_member, tenant_billing_wallet, tenant_billing_transaction, tenant_usage_meter, tenant_gateway_config, tenant_sms_config, tenant_bot_integration, tenant_restriction]
depends_on: [identity, billing]
updated: 2026-09-09
---

# Tenant

**Responsibility (one sentence):** the multi-tenant / reseller white-label core —
a Tenant's identity, branding, domains, feature entitlements, platform-side
billing, and bring-your-own gateway / SMS / bot integrations.
**Explicitly NOT responsible for:** end-user wallets or payments (`billing`),
end-user RBAC (`identity`), product pricing (`catalog`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing tenant from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | **`draft` -> `active`**, contract v1 -> **v2**: *resolve tenant by host* is implemented (ADR-0020) — `app/tenant/` in the `auth-service` process, the way `app/account-switch/` hosts `audit`'s. Every other operation in the contract is still intended only. spec: F-061-a |
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
