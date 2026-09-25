---
id: entitlement
layer: domain
status: draft
updated: 2026-09-25
---

# Invariants — entitlement

Held by the database since F-026-b; proved by
`billing-service/src/app/entitlement/entitlement-schema.int.spec.ts`. Rule 1 is
the service's, with F-026-e. Rules 8–13 arrive with F-027-f's columns
(ADR-0072, ADR-0073, ADR-0075); rule 10 is held by `GrantService.issue` since
F-027-p and rule 8 by `CeilingAllocatorService` since F-027-s, the rest by the
database — the shapes are proved by
`shared-core/src/lib/prisma/entitlement-grant-purchase-and-purge.spec.ts`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Access is answered only by "an active Grant with this feature key exists" — never by a plan name or a role | F-026-e `hasActiveGrant` | access sold twice, or given free |
| 2 | Status moves one way; only `suspended → active` returns | trigger `grant_status_one_way` | an expired Grant revived for free |
| 3 | A Grant's quota changes only by a `quota_adjustment` row, and that row is never changed | trigger `quota_adjustment_is_history` | usage that cannot be reconciled |
| 4 | Quota is on the Grant; every config of a Grant draws on one quota | `config.grantId`; F-027 | a family plan billed five times |
| 5 | A Grant, its adjustments and its configs are one tenant's; its variant the platform's or that tenant's | trigger `same_tenant` + strict RLS | one tenant reads or sells into another's customers |
| 6 | The subscription token is stored in clear nowhere: only its SHA-256 and a copy sealed under a key derived from the KEK, which lives outside the database (ADR-0085) | CHECK `grant_token_hash_shape`, `grant_token_sealed_shape` | a database leak hands out every working link |
| 7 | One cause issues one Grant | partial unique `(source, sourceReferenceId)` | a retried coupon or payment grants twice |
| 8 | No byte is served that has not been paid for: `Σ ceilings ≤ purchasedBytes` across every config of a Grant | `CeilingAllocatorService` splits the bag so it holds by construction, proved over generated Grants by `ceiling-allocator.spec.ts` (F-027-s, [network/contract.ceiling.md](../network/contract.ceiling.md)) | free traffic at the far end of a ceiling nobody bounded |
| 9 | No byte counter is ever negative — a counter going backward is a reset, never negative usage | CHECK `grant_byte_counters_not_negative` | a reset read as negative usage, and a refund of traffic nobody bought |
| 10 | A byte is priced by the rate locked at issue, never by the catalog's rate today | `grant.meteredRate` copied by `issue` from the rate in effect at `startsAt`, and a metered variant with none is refused (F-027-p, `grant.spec.ts`); CHECK `grant_metered_rate_is_metered` | a price change reprices blocks already bought — ledger and cursor disagree |
| 11 | A suspended Grant always carries the clock it will be purged by | CHECK `grant_suspended_has_a_clock` | a panel seat held forever, with nothing red anywhere |
| 12 | Quota exhaustion is `suspended`, never `exhausted` — with `suspendedAt`, and every config of the Grant `desiredEnabled = false` | `suspendForExhaustion` is the only writer of the reason, and suspends only when the bag is spent and the locked wallet funds no block (F-027-x, `traffic/exhaustion.spec.ts`); trigger `grant_status_one_way` (rule 2) makes `exhausted` terminal | a top-up can never revive the Grant it paid for |
| 13 | A purge never deletes one of our rows — it writes `desiredRemote = absent` and nothing else; `remoteId` is cleared only by the loop that confirmed the delete | `GrantPurgeService.purgeDue` writes that column alone (F-027-y, `purge.spec.ts`, ADR-0075) | a rebuild becomes a reconstruction, and the history of what a user held is gone |
| 14 | A paid Grant ends delivered or refunded, never both and never neither: `pending` only until one of them, each conditional on `pending`, and a refund is the invoice's whole `total`, once | `markDelivered` and `GrantDeliveryService.refund` both write `where status = pending`; the invoice flips `paid -> refunded` under its row lock or the refund rolls back (F-111-d, `delivery.spec.ts`, `invoice-payment.int.spec.ts`) | a user charged for nothing, or given the service and the money back |

## How to test

`npm run test:int` (billing-service).
