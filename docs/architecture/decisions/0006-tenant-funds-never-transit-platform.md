---
id: adr-0006
status: superseded
updated: 2026-09-12
superseded_by: adr-0041
---

# ADR 0006 — Tenant end-user funds never transit the platform

- **Status:** superseded by **ADR-0041** (2026-09-12) — its rule is still the **default**: a tenant sees only the gateways it configured itself. What changed is that the platform owner may grant a tenant another party's gateway, and then settles what that gateway collected.
- **Date:** 2026-09-04 (documented; predates this doc)
- **Affects units:** tenant, billing

## Context

Resellers collect money from their own end users. Routing that money through the
platform's gateway would make the platform a payment aggregator (licensing,
settlement, chargeback liability, reverse-settlement wallets).

## Decision

Each Tenant **must** connect its own payment gateway (`TenantGatewayConfig`) and
its own SMS/bot credentials. The platform only ever bills the Tenant
(`TenantBillingWallet` + `TenantBillingTransaction`: subscription or metered
usage). There is **no** platform-owned settlement wallet paying tenants, and no
shared gateway option for resellers — `billing.PaymentGateway` is for the
platform-owner brand only.

## Consequences

- Positive: platform is not a money transmitter; blast radius of a gateway
  problem is one tenant.
- Negative / accepted cost: onboarding a reseller requires them to have a
  merchant account; the platform cannot offer "instant payouts".
- Forecloses: a marketplace model where the platform holds tenant balances.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Shared platform gateway, platform settles to tenants | regulatory + liability |
| Optional shared gateway | still makes the platform an aggregator |

## Revisit trigger

Obtaining a payment-institution licence, or a jurisdiction where aggregation is
low-risk.
