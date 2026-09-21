---
id: entitlement
layer: domain
status: draft
updated: 2026-09-21
---

# Invariants — entitlement

Held by the database since F-026-b; proved by
`billing-service/src/app/entitlement/entitlement-schema.int.spec.ts`. Rule 1 is
the service's, with F-026-e. Rules 8–12 arrive with F-027-f's columns
(ADR-0072, ADR-0073, ADR-0075); 8 and 10 are held by the code that will read
them, the rest by the database — the shapes are proved by
`shared-core/src/lib/prisma/entitlement-grant-purchase-and-purge.spec.ts`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Access is answered only by "an active Grant with this feature key exists" — never by a plan name or a role | F-026-e `hasActiveGrant` | access sold twice, or given free |
| 2 | Status moves one way; only `suspended → active` returns | trigger `grant_status_one_way` | an expired Grant revived for free |
| 3 | A Grant's quota changes only by a `quota_adjustment` row, and that row is never changed | trigger `quota_adjustment_is_history` | usage that cannot be reconciled |
| 4 | Quota is on the Grant; every config of a Grant draws on one quota | `config.grantId`; F-027 | a family plan billed five times |
| 5 | A Grant, its adjustments and its configs are one tenant's; its variant the platform's or that tenant's | trigger `same_tenant` + strict RLS | one tenant reads or sells into another's customers |
| 6 | The subscription token is never stored — only its SHA-256 | CHECK `grant_token_hash_shape` | a database leak hands out every working link |
| 7 | One cause issues one Grant | partial unique `(source, sourceReferenceId)` | a retried coupon or payment grants twice |
| 8 | No byte is served that has not been paid for: `Σ ceilings ≤ purchasedBytes` across every config of a Grant | F-027-s allocator + property test; `purchasedBytes` is its own column | free traffic at the far end of a ceiling nobody bounded |
| 9 | No byte counter is ever negative — a counter going backward is a reset, never negative usage | CHECK `grant_byte_counters_not_negative` | a reset read as negative usage, and a refund of traffic nobody bought |
| 10 | A byte is priced by the rate locked at issue, never by the catalog's rate today | `grant.meteredRate` copied by `issue` (F-027-p); CHECK `grant_metered_rate_is_metered` | a price change reprices blocks already bought — ledger and cursor disagree |
| 11 | A suspended Grant always carries the clock it will be purged by | CHECK `grant_suspended_has_a_clock` | a panel seat held forever, with nothing red anywhere |
| 12 | Quota exhaustion is `suspended`, never `exhausted` | trigger `grant_status_one_way` (rule 2) makes `exhausted` terminal | a top-up can never revive the Grant it paid for |

## How to test

`npm run test:int` (billing-service).
