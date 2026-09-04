---
id: tenant
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — tenant

**DRAFT — schema only, no service implements this yet.** Shapes below are the
intended surface derived from `txnet-backend/prisma/domains/tenant.prisma`.

## TL;DR

A Tenant is an isolation + branding boundary. Exactly one is `platform_owner`;
the rest are `reseller`. The platform bills tenants (subscription or metered
usage); tenants collect from their own end users through their own gateway
(ADR-0006). A central entitlement check gates every feature per tenant.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| resolve tenant by host | request host / slug | tenant + branding + enabled feature keys | sync | unknown domain |
| check entitlement | tenantId, featureKey | allowed / denied (+ source, expiry) | sync | — |
| verify custom domain | tenantId, domainValue | verification status | async (DNS TXT / ArvanCloud) | token mismatch |
| charge tenant | tenantId, reason, amount | `tenant_billing_transaction` (append-only) | sync tx | insufficient / wallet missing |
| meter usage | tenantId, meterKey, quantity, period | `tenant_usage_meter` row | async (worker) | — |
| set BYO gateway/SMS/bot config | tenantId, encrypted credentials | config row, `pending` verification | sync | — |

## Emits (events)

None planned yet. Metering + domain verification are intended as `automation`
workers.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `ownerUserId`, `tenant_staff_member.userId` | cannot create tenant/staff |
| billing | `PaymentProviderName` / `GatewayCategory` enums for `tenant_gateway_config` | — |

## Guarantees (intended)

- Every feature execution checks `tenant_feature_entitlement` even if the feature
  is globally enabled.
- `tenant_billing_wallet.cachedBalance` is a cache; `tenant_billing_transaction`
  is the truth (ADR-0002), with optimistic-lock `version`.
- `platform_owner` is unique (planned CHECK/trigger, schema "section 99").

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
