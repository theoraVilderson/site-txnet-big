---
id: entitlement
layer: domain
status: draft
version: 1
updated: 2026-09-22
---

# Contract — entitlement

**Storage built (F-026-b); Grant core built (F-026-e), metered rate locked at
issue (F-027-p) — `entitlement/grant.ts`, proved by `grant.spec.ts`.** In-process only. Spec:
catalog §4.4–4.6 (`tools/spec.py --section 4.4`). Decision: ADR-0049.

## TL;DR

A user's access to anything is one question: **does an active Grant with this
feature key exist?** A Grant is issued from a catalog variant (its quotas,
duration and feature keys copied at issue), moves one way through its states,
and changes its quota only through `quota_adjustment` rows.

## Provides (built, F-026-e — `GrantService`)

| Operation | Input | Output | Sync/Async | Errors (`EntitlementRefused.reason`) |
|---|---|---|---|---|
| `issue(tx, …)` | userId, variantId, source, sourceReferenceId?, startsAt?, issuedByAdminId? | `{grant, token}` — the token once; a repeat for the same cause answers the first Grant and `token: null` | inside the caller's transaction | `variant_not_found`, `variant_not_assignable`, `metered_rate_missing`, `metered_rate_not_positive`, `already_issued` (a concurrent issue won: retry) |
| `transition(tx, id, to, reason?)` | grantId, status | Grant; staying put is a no-op | caller's transaction | `grant_not_found`, `illegal_transition` |
| `activeGrant` / `hasActiveGrant` | userId, featureKey, at? | the longest-lasting active Grant / boolean | own tenant transaction | — |
| `adjustQuota(tx, …)` | grantId, metric, delta, source, capPercent?, expiresAt?, reason? | QuotaAdjustment | caller's transaction | `grant_not_found`, `grant_not_active` |
| `rotateToken(tx, id, userId)` | grantId, its user | the new token, once | caller's transaction | `grant_not_found` (also for another user's) |
| `rotateTokenForUser(id, userId)` | grantId, its user | the same, in a transaction of its own | own tenant transaction | the same |
| `listForUser(userId, {page?, pageSize?})` | the user, paging | one page of that user's Grants — id, status, period, feature keys, variant `{id, sku, nameKey}`; never the token or its hash | own tenant transaction | — |

Issue rules: a `purchase` needs a `public` or `unlisted` variant; any other
source may assign any live variant, `admin_only` included (F-506). A purchase
starts `pending`; every other source `active`. Quotas, feature keys, billing
mode and `endsAt = startsAt + durationDays` are copied at issue.

A **metered** variant also has its rate copied: the `catalog.metered_rate` row
in effect at `startsAt` is locked onto `Grant.meteredRate` (F-027-p, ADR-0073),
and every block bought against that Grant is priced from the Grant's own
column — a catalog edit tomorrow never reprices what was sold. A metered
variant with **no** rate in effect is refused (`metered_rate_missing`), and one
whose rate in effect is **zero** with `metered_rate_not_positive` (F-027-al) —
a block priced at nothing cannot be bought, so such a Grant stalls at its first
block rather than serving free traffic; the catalog column refuses the same
value (`metered_rate_is_positive`). Nothing is
copied for any other billing mode: `grant_metered_rate_is_metered` refuses a
rate on a prepaid Grant.

In-process calls from `billing-service` modules (ADR-0049); HTTP routes are
added only when a row needs them. Two do: `rotateTokenForUser` over `POST
/api/billing/gift/grants/:id/rotate-token` (F-502-p) and `listForUser` over
`GET /api/billing/gift/grants` (F-502-r). Both belong to `billing` and are
written down in its `contract.gift.md`.

## Emits (events)

None yet.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| catalog | a variant's quotas, `durationDays`, `billingMode`, its product's feature keys, and — when metered — its `metered_rate` in effect at the sale (F-027-p) | cannot issue |
| identity | the user a Grant is issued to | cannot issue |
| tenant | the ambient tenant (ADR-0024) | refuses |

## Consumers

| Unit | What it reads |
|---|---|
| network | `config.grantId`: a config draws on its Grant's quota (F-027) |
| billing | issues a Grant for a `free_grant` coupon (F-502-l) and, later, a purchase |

## Guarantees (built — `entitlement-schema.int.spec.ts`)

| Rule | Held by |
|---|---|
| A tenant reads and writes only its own Grants and adjustments — never shared-read | RLS, strict |
| A Grant's user is its tenant's; its variant is the platform's or its tenant's; an adjustment and a config are their Grant's tenant's (`entitlement_tenant_mismatch`) | trigger `entitlement.same_tenant` |
| `pending → active → (suspended \| exhausted \| expired \| cancelled)`, `pending → cancelled`; only `suspended → active` goes back (`grant_status_one_way`) | trigger |
| The subscription token is stored only as SHA-256 lowercase hex, unique; the token is shown once — at issue and on rotation (`grant_token_hash_shape`) | CHECK + unique index; the user's call 2026-09-14 |
| One cause issues one Grant: `(source, sourceReferenceId)` unique when set | partial unique index |
| A quota adjustment is never changed or deleted; `delta ≠ 0`; a rollover cap is 1..100 % (`quota_adjustment_is_history`) | trigger + CHECKs |
| `endsAt = null` is permanent; when set it is after `startsAt`. Quota sits on the Grant, never on a config (§4.6) | CHECK; schema |

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
