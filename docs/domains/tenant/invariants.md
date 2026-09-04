---
id: tenant
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — tenant

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Exactly one `tenant` row has `tenantType = platform_owner` | planned CHECK/trigger (schema "section 99") — NOT applied | ambiguous platform identity, billing routing errors |
| 2 | Tenant end-user money never enters a platform wallet; there is no platform->tenant settlement wallet (ADR-0006) | design / absence of such a table | platform becomes a money transmitter |
| 3 | `tenant_billing_wallet` balance is never written directly — only via append-only `tenant_billing_transaction` + `balanceAfter` (ADR-0002) | planned service layer | silent money drift |
| 4 | Encrypted credential fields (`merchantIdEncrypted`, `apiKeyEncrypted`, `botTokenEncrypted`, `ownApiKeyEncrypted`) are never default-selected or logged | planned service `select`/`omit` | tenant gateway/bot takeover |
| 5 | A `custom_domain` only routes after `verificationStatus = verified` | planned domain-verifier worker | domain hijack / cert misissue |
| 6 | A feature runs for a tenant only if `tenant_feature_entitlement.isEnabled` (and not expired) for that `featureKey` | planned central guard | unpaid feature usage |
| 7 | `tenant_usage_meter` rows are billed exactly once (`isBilled` + `billedTransactionId`) | planned metering worker | double / missed charges |

## How to test

To be written when the service exists. Minimum: a test that a second
`platform_owner` insert fails, and that the entitlement guard denies a disabled
feature key.
