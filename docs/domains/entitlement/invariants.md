---
id: entitlement
layer: domain
status: draft
updated: 2026-09-14
---

# Invariants — entitlement

Held by the database since F-026-b; proved by
`billing-service/src/app/entitlement/entitlement-schema.int.spec.ts`. Rule 1 is
the service's, with F-026-e.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Access is answered only by "an active Grant with this feature key exists" — never by a plan name or a role | F-026-e `hasActiveGrant` | access sold twice, or given free |
| 2 | Status moves one way; only `suspended → active` returns | trigger `grant_status_one_way` | an expired Grant revived for free |
| 3 | A Grant's quota changes only by a `quota_adjustment` row, and that row is never changed | trigger `quota_adjustment_is_history` | usage that cannot be reconciled |
| 4 | Quota is on the Grant; every config of a Grant draws on one quota | `config.grantId`; F-027 | a family plan billed five times |
| 5 | A Grant, its adjustments and its configs are one tenant's; its variant the platform's or that tenant's | trigger `same_tenant` + strict RLS | one tenant reads or sells into another's customers |
| 6 | The subscription token is never stored — only its SHA-256 | CHECK `grant_token_hash_shape` | a database leak hands out every working link |
| 7 | One cause issues one Grant | partial unique `(source, sourceReferenceId)` | a retried coupon or payment grants twice |

## How to test

`npm run test:int` (billing-service).
