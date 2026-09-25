---
id: entitlement
layer: domain
status: draft
version: 4
updated: 2026-09-25
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
| `listForUser(userId, {page?, pageSize?})` | the user, paging | one page of that user's Grants — id, status, period, feature keys, variant `{id, sku, nameKey}`, billing mode, consumed/purchased bytes, `suspendedAt` and `purgeAt` (F-027-ac, `purgeAtOf`); never the token or its hash | own tenant transaction | — |

**Exhaustion suspends (F-027-x, ADR-0075)** — `suspendForExhaustion(tx,
grantId, at)` in `entitlement/suspension.ts`, a function rather than a
`GrantService` method so the hot loop calls it without a module import. It
moves an `active` Grant to `suspended` with `statusReason = 'quota_exhausted'`
(`QUOTA_EXHAUSTED`) and `suspendedAt = at`, and sets `desiredEnabled = false`
on **every** config of the Grant — desired state, carried to each panel by the
convergence loop (F-027-z), never a command. The write is conditional on
`active`: a Grant that moved on is left alone and a repeat is a no-op
(`suspended: false`). It does not decide exhaustion — that is money, and
billing's `traffic/exhaustion.ts` decides it under a wallet lock
(`network/contract.hot-loop.md`). `transition()` cannot do this: it writes no
`suspendedAt`, which `grant_suspended_has_a_clock` refuses.

**Purge and restore (F-027-y, ADR-0075)** — `entitlement/purge.ts`. A
suspension frees nothing: the client still holds a seat and a licence on the
customer's panel. `GrantPurgeService.purgeDue(now)` is the second stage — for
every suspended Grant past its window it sets `desiredRemote = absent` and
`enforcementState = pending` on each config still `present`, and **writes
nothing else**. The row is not deleted and `remoteId` is not cleared; that is
the convergence loop's, once the panel confirms the delete (F-027-z). The
window is `coalesce(grant.purgeAfterDays, tenant.purgeAfterDays)` read live,
`0` = never, and it is resolved **in the scan** — a never-purge row filtered
out afterwards would fill every bounded batch and starve the due rows behind
it. The scan is cross-tenant and each write runs in its tenant
(`deposit-expiry.service.ts` gives the argument); already-purged Grants are
excluded, so the sweep drains itself and a second call answers zero.

`reviveOnTopUp(tx, grantId)` is the way back, from **either** stage: `active`
with `statusReason` and `suspendedAt` cleared, and every `status = active`
config `desiredEnabled = true`, `desiredRemote = present`, `enforcementState =
pending`, so a purged Grant is rebuilt from desired state rather than
reconstructed. A `retired` config (deleted, or moved away) and one an admin
disabled stay as they are (`network/contract.provisioning.md`, F-027-z). It is guarded on
`statusReason = quota_exhausted` in the write's own `where`: `suspended` has
two meanings and a top-up buys traffic, not an amnesty.

Its caller is the credit itself (F-027-ap, ADR-0079). `reviveFundedGrants(tx,
userId, balance)` in `entitlement/revival.ts` is called by
`WalletCreditService` on every credit to a user's wallet, and revives a Grant
only where `walletCanBuy` — the predicate `suspendIfExhausted` suspended on —
is true at that Grant's own locked rate. Writing it as a second rule about
money would let the two drift, and the drift lands on the purge clock. A
revived Grant is `active` with its configs `present` and enabled, and **no
ceiling until something buys it a block** — which is the hot loop, still
without a caller (F-027-u).

The clock is not here. `worker-service` holds it and asks hourly over `POST
/api/internal/billing/entitlement/purge-due` (`ServiceOnlyGuard`, key
`grant_config_purge`), because background work does not run in a
request-serving process (ADR-0027, `automation/contract.worker.md`).

Issue rules: a `purchase` needs a `public` or `unlisted` variant; any other
source may assign any live variant, `admin_only` included (F-506). A purchase
starts `pending`; every other source `active`. Quotas, feature keys, billing
mode and `endsAt = startsAt + durationDays` are copied at issue. A `pending`
Grant of a variant with a panel group is moved to `active` by group fulfilment
once `minHealthyPanels` of its configs are confirmed (network
`contract.groups.md` rule 10, F-027-bl).

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

**Delivery of a paid Grant (F-111-d, spec §5.8 step 3)** —
`entitlement/delivery.ts`, proved by `delivery.spec.ts` and, against Postgres,
`invoice/invoice-payment.int.spec.ts`. A purchase is issued `pending`;
`GrantDeliveryService.deliverDue` checks each one whose `nextDeliveryAt` is due
(null = at once) over `POST /api/internal/billing/entitlement/deliver-due`
(`ServiceOnlyGuard`), asked every minute by `grant_delivery`. Answer:
`scanned`, `delivered`, `waiting`, `refunded`, `failed`.

| Rule | Why |
|---|---|
| The handler is the product's `fulfilmentKind` (`DELIVERY_ROUTE`, exhaustive): `feature_access` is delivered at the first check; `network_access` by its panel group — group fulfilment activates it at `minHealthyPanels` (network `contract.groups.md` rule 10), on this check or its own tick | a new kind does not compile until somebody says how it is delivered |
| **No handler** — `external_order`, `wallet_topup`, a network variant with no group — is refunded at the first check, `statusReason = no_delivery_route`, and is not sold at all (`contract.purchase.md`) | the user's call, 2026-09-25: an hour of retries cannot deliver it |
| Checked at once, then retried after 1, 2, 4, 8, 16, 32 minutes (`GRANT_DELIVERY_RETRIES` = 6, `GRANT_DELIVERY_FIRST_RETRY_MS` = 60 000, doubling); the check after the last finds it `pending` → refunded, `delivery_timed_out`. `strategy_not_built` is a failed check | the user's call, 2026-09-25: a panel down a few minutes refunds nobody, and nobody waits past the hour |
| `markDelivered(tx, id)` (`delivered.ts`) is the one way to deliver: `pending -> active` conditional on `pending`, plus `entitlement.grant.delivered` | group fulfilment and this sweep both deliver; the buyer hears once, whichever wins |
| A refund, one transaction: `pending -> cancelled` conditional on `pending`; every config retired (`GRANT_DELIVERY_ACTOR`); the invoice `paid -> refunded` under its row lock — anything else rolls it all back; one `product_refund` credit of `total` through `WalletCreditService` (none for a free invoice); `entitlement.grant.refunded` | a delivery that won the race is never refunded, a refund is never paid twice, and no client outlives the money |
| The coupon uses stay used | the refund is `total`, what the user paid |

In-process calls from `billing-service` modules (ADR-0049); HTTP routes are
added only when a row needs them. Two do: `rotateTokenForUser` over `POST
/api/billing/gift/grants/:id/rotate-token` (F-502-p) and `listForUser` over
`GET /api/billing/gift/grants` (F-502-r). Both belong to `billing` and are
written down in its `contract.gift.md`.

## Emits (events)

Through the outbox (ADR-0021), both also live on the buyer's `user:` channel
(`contracts/realtime/events.json`); consumer `GrantDeliveryConsumer`
(`automation/contract.outbox.md`).

| Event | Payload | When |
|---|---|---|
| `entitlement.grant.delivered` | `tenantId, userId, grantId, variantId, source, invoiceId` | a `pending` Grant turned `active` (F-111-d) |
| `entitlement.grant.refunded` | `tenantId, userId, grantId, invoiceId, amount, reason` | a paid Grant cancelled, its invoice refunded whole (F-111-d) |

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| catalog | a variant's quotas, `durationDays`, `billingMode`, its product's feature keys, and — when metered — its `metered_rate` in effect at the sale (F-027-p) | cannot issue |
| identity | the user a Grant is issued to | cannot issue |
| tenant | the ambient tenant (ADR-0024) | refuses |

## Consumers

| Unit | What it reads |
|---|---|
| network | `config.grantId`: a config draws on its Grant's quota (F-027); group fulfilment moves a grouped `pending` Grant to `active` (F-027-bl) |
| billing | issues a Grant for a `free_grant` coupon (F-502-l) and, later, a purchase; the hot loop suspends a spent one (F-027-x) |
| automation | holds the purge clock: `grant_config_purge` asks `purge-due` hourly (F-027-y), and the delivery clock: `grant_delivery` asks `deliver-due` every minute (F-111-d); tells the buyer on either event |

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
