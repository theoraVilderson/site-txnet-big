---
id: entitlement
layer: domain
status: draft
version: 12
updated: 2026-09-29
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
| `issue(tx, …)` | userId, variantId, source, sourceReferenceId?, startsAt?, issuedByAdminId? | `{grant, token}` — the token, also kept sealed (ADR-0085); a repeat for the same cause answers the first Grant and `token: null` | inside the caller's transaction | `variant_not_found`, `variant_not_assignable`, `metered_rate_missing`, `metered_rate_not_positive`, `meter_not_served`, `already_issued` (a concurrent issue won: retry) |
| `transition(tx, id, to, reason?)` | grantId, status | Grant; staying put is a no-op | caller's transaction | `grant_not_found`, `illegal_transition` |
| `activeGrant` / `hasActiveGrant` | userId, featureKey, at? | the longest-lasting active Grant / boolean | own tenant transaction | — |
| `adjustQuota(tx, …)` | grantId, metric, delta, source, capPercent?, expiresAt?, reason? | QuotaAdjustment | caller's transaction | `grant_not_found`, `grant_not_active` |
| `rotateToken(tx, id, userId)` | grantId, its user | the new token, kept sealed; the old link stops working | caller's transaction | `grant_not_found` (also for another user's) |
| `subscriptionTokenFor(tx, id, userId)` | grantId, its user | the current token, as often as asked; `null` when none is kept (a Grant from before F-114-e-a, or issued with no KEK) — resetting keeps one | caller's transaction | `grant_not_found` (also for another user's); throws if the opened token does not hash to the row |
| `listForUser(userId, {page?, pageSize?})` | the user, paging | one page of that user's Grants — id, status, period, feature keys, variant `{id, sku, nameKey}`, billing mode, consumed/purchased bytes, `suspendedAt` and `purgeAt` (F-027-ac, `purgeAtOf`); never the token or its hash; `frozen` + `frozenUntil` (F-311-h), and no `purgeAt` for a frozen one | own tenant transaction | — |

**Exhaustion suspends (F-027-x, ADR-0075)** — `suspendForExhaustion(tx,
grantId, at)` in `entitlement/suspension.ts`, a function rather than a
`GrantService` method so billing's exhaustion check calls it without a module import. It
moves an `active` Grant to `suspended` with `statusReason = 'quota_exhausted'`
(`QUOTA_EXHAUSTED`) and `suspendedAt = at`, and sets `desiredEnabled = false`
on **every** config of the Grant — desired state, carried to each panel by the
convergence loop (F-027-z), never a command. The write is conditional on
`active`: a Grant that moved on is left alone and a repeat is a no-op
(`suspended: false`). It does not decide exhaustion — that is money, and
billing's `traffic/exhaustion.ts` decides it: for a metered Grant under a
wallet lock, asked by a refused block request (`network/contract.hot-loop.md`);
for a prepaid one (F-027-dw, ADR-0096) by `suspendIfClosed` under the Grant's
row lock, asked by `network.grant.closed` — the lease planner's close, read
again against Quota and end, so a renewal that reopened it is never undone.
Each stop is told to the user (F-601-b, `contract.retention.md` "Cutoff"). A renewal
(`renewal.ts`) revives it; a wallet top-up does not. That revival, and a top-up's of a metered Grant, is told (F-601-k, `contract.retention.md` "Active again"). `transition()` cannot do this: it writes no
`suspendedAt`, which `grant_suspended_has_a_clock` refuses.

**Running out of days suspends too (F-027-do, user 2026-09-27)** — never
`expired`, which is terminal and would leave a renewal nothing to land on.
When the planner's close stands on a passed end, `suspendIfClosed` suspends the
Grant, prepaid, metered or unlimited, with `statusReason = 'period_ended'`
(`PERIOD_ENDED`, `suspendForPeriodEnd`), purge clock started. Only a renewal
revives it (`reviveOnRenewal`): its end ahead again and, for a bag, Quota past
Used; with days but a spent bag it becomes `quota_exhausted`, clock running.
Bytes alone (a top-up, `settle`) revive nothing: the guard is the reason.

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
ceiling until the lease planner gives it one** — on its next turn over one of
its configs, which leases the reserve and asks for the block (F-027-dc).

The clock is not here. `worker-service` holds it and asks hourly over `POST
/api/internal/billing/entitlement/purge-due` (`ServiceOnlyGuard`, key
`grant_config_purge`), because background work does not run in a
request-serving process (ADR-0027, `automation/contract.worker.md`). The same
call tells the Grants a day from their purge (F-601-j, `contract.retention.md`).

**Renewal is `Quota += X` on the same Grant (F-027-dg, SPEC weakness #30)** —
`renewGrant(tx, {grantId, bytes, days, source, …})` in
`entitlement/renewal.ts`, in the caller's transaction. It raises
`purchasedBytes` and moves `endsAt` by `days` (from now if already past; a
permanent Grant stays permanent) on the Grant the user already holds, so its
link and configs stay. Quota and Used are cumulative — Used is Σ lifetime
counters over every config, retired ones included, the planner's own sum
(`network/contract.lease.md` rule 1) — so a credit carries by itself and a
debt is Used already past Quota. **A debt up to 2 GiB is forgiven**
(`DEBT_FORGIVEN_UP_TO`, user 2026-09-27: panel tick lag, not the user's
doing): Quota rises by it too, as its own `quota_adjustment` row with reason
`debt_forgiven`. A larger debt is carried whole. Each raise is an adjustment
row (invariant 3). A Grant suspended for quota is revived (`reviveOnTopUp`)
when the raise leaves room; the planner reopens a closed one on the moved
Quota or end (rule 25). Refused: `grant_not_renewable` (not `active` or
`suspended`; a lapsed Grant is `suspended`, F-027-do), `traffic_not_renewable` (bytes
on a metered or unlimited Grant, which renew by days alone),
`nothing_to_renew`, `grant_moved` (Quota or end changed since the read: retry,
so no debt is forgiven twice). An admin's renewal is F-311-d (contract.admin.md "Renew"); the user's arrives with F-305.

**An admin's actions on a Grant (F-311-h, -i, -j)** — freeze, days, traffic:
[contract.admin.md](contract.admin.md). Their routes are billing's `contract.reseller-grants.md`.

**Unlimited traffic (F-111-q).** A prepaid variant sold with
`traffic_bytes.limit = 0` (catalog invariant 10) is issued with
`trafficUnlimited = true` and `purchasedBytes = 0` — the flag, never the
number, because downstream 0 means empty. Such a Grant gets no ceiling
(network `contract.ceiling.md`), is never suspended as exhausted
(`suspendIfExhausted` → `unlimited`), never buys a block, and its usage is
still recorded. It is sold: its configs carry the flag and are placed with no
limit (network `contract.provisioning.md`, F-111-r).

Issue rules: a `purchase` needs a `public` or `unlisted` variant; any other
source may assign any live variant, `admin_only` included (F-506). A purchase
starts `pending`; every other source `active`. Quotas, feature keys, billing
mode, `periodDays` and `endsAt = startsAt + durationDays` are copied at issue. A `pending`
Grant of a variant with a panel group is moved to `active` by group fulfilment
once `minHealthyPanels` of its configs are confirmed (network
`contract.groups.md` rule 10, F-027-bl).

A **metered** variant also has its rate locked: the `vpn.traffic` rate card
(`catalog.rate_card`, F-118-d) in effect at `startsAt`, in the tenant's operating currency, is its
`vpn.traffic` `grant_meter` below — the Grant's only rate since F-118-l (ADR-0073,
F-116-d): a block is debited in its currency, and every block bought against
that Grant is priced from it — a catalog edit tomorrow never reprices what was sold. A metered
variant with **no** rate in effect in that currency — or whose newest card the byte engine
cannot serve yet (postpaid, included, not per 2^30 bytes; `vpnTrafficRateAt`) — is refused (`metered_rate_missing`), and one
whose rate in effect is **zero** with `metered_rate_not_positive` (F-027-al) —
a block priced at nothing cannot be bought, so such a Grant stalls at its first
block rather than serving free traffic; the catalog column refuses the same
value (`rate_card_metered_price_positive`). A prepaid Grant gets no
`vpn.traffic` meter, so it carries no rate.

**Its meters are locked beside it (F-118-e, ADR-0105 decision 4)** — `grant-meter.ts`: one
`grant_meter` row per card in effect (terms, `rateCardId`, counters at 0). A metered VPN
Grant's `vpn.traffic` row is its rate and money cursor (F-118-l, billing `contract.traffic-block.md`); a package plan has none (decision 0); a card on a
meter nothing serves yet refuses the sale (`meter_not_served`, decision 7). `usage_event` advances `consumed` (billing `contract.metering.md`, F-118-f).
**A reseller's meter also locks its wholesale leg (F-118-n2, decision 10)** — `lockWholesale`: the payer (the Grant's tenant) and its package's `tenant_package_meter_rate` in force at `startsAt` (tenant `contract.admin.md`), in the platform's currency, `wholesaleBilled` at 0 — for **every** meter a reseller sells, whatever its panel group holds (user, 2026-09-29: members change after the sale; whether a unit is charged is its panel's owner's question, F-118-n3). A meter the package does not price, or no package, refuses the sale (`wholesale_rate_missing`, 409 on the admin route). The platform's own sales and package plans read no package.

**Delivery of a paid Grant (F-111-d, spec §5.8 step 3)** —
`entitlement/delivery.ts`, proved by `delivery.spec.ts` and, against Postgres,
`invoice/invoice-payment.int.spec.ts`. A purchase is issued `pending`;
`GrantDeliveryService.deliverDue` checks each one whose `nextDeliveryAt` is due
(null = at once) over `POST /api/internal/billing/entitlement/deliver-due`
(`ServiceOnlyGuard`), asked every minute by `grant_delivery`. Answer:
`scanned`, `delivered`, `waiting`, `refunded`, `failed`.
The same check for one Grant — `deliverNow`, over
`POST /api/internal/billing/entitlement/grants/:grantId/deliver`, answer
`{ outcome }` — is asked the moment `entitlement.grant.created` is published
(F-114-i); it checks only a Grant still `pending` and due (`dueForDelivery`),
so a repeat is `skipped` and the minute sweep stays the backstop.

| Rule | Why |
|---|---|
| The handler is the product's `fulfilmentKind` (`DELIVERY_ROUTE`, exhaustive): `feature_access` is delivered at the first check; `network_access` by its panel group — group fulfilment activates it at `minHealthyPanels` (network `contract.groups.md` rule 10), on this check or its own tick | a new kind does not compile until somebody says how it is delivered |
| **No handler** — `external_order` and `wallet_topup` (retired, F-111-h / F-111-g — only a product made before it can exist), a network variant with no group — is refunded at the first check, `statusReason = no_delivery_route`, and is not sold at all (`contract.purchase.md`) | the user's call, 2026-09-25: an hour of retries cannot deliver it |
| Checked at once, then retried after 1, 2, 4, 8, 16, 32 minutes (`GRANT_DELIVERY_RETRIES` = 6, `GRANT_DELIVERY_FIRST_RETRY_MS` = 60 000, doubling); the check after the last finds it `pending` → refunded, `delivery_timed_out`. `strategy_not_built` is a failed check | the user's call, 2026-09-25: a panel down a few minutes refunds nobody, and nobody waits past the hour |
| `markDelivered(tx, id)` (`delivered.ts`) is the one way to deliver: `pending -> active` conditional on `pending`, plus `entitlement.grant.delivered` | group fulfilment and this sweep both deliver; the buyer hears once, whichever wins |
| A refund, one transaction: `pending -> cancelled` conditional on `pending`; every config retired (`GRANT_DELIVERY_ACTOR`); the invoice `paid -> refunded` under its row lock — anything else rolls it all back; one `product_refund` credit of `total` through `WalletCreditService` (none for a free invoice); `entitlement.grant.refunded` | a delivery that won the race is never refunded, a refund is never paid twice, and no client outlives the money |
| The coupon uses stay used | the refund is `total`, what the user paid |
| **Still waiting** (F-601-i): the first check that leaves it `pending` `GRANT_DELIVERY_DELAYED_AFTER_MS` (5 min — the 7-minute check) after `createdAt` sets `deliveryDelayedAt`, conditional on null, and emits `entitlement.grant.delivery_delayed`. `reason` (`DELIVERY_DELAYS`): `panel_unavailable` — a panel owed a config cannot take one (not accepted or serving, no inbound picked, full); `write_unconfirmed` — every owed panel has one and too few confirmed it (a refused write, or not read back yet); `strategy_not_built` | buyer and seller hear once, well before the hour's refund; a check that delivers or refunds has its own notice |

**Retention notices** — "not connected yet?" (F-601-c), usage thresholds
(F-601-d) and time thresholds (F-601-e): what this unit emits, when, and the
clocks behind them are [contract.retention.md](contract.retention.md).

In-process calls from `billing-service` modules (ADR-0049); HTTP routes are
added only when a row needs them. Three do: `subscriptionTokenFor` over `GET
/api/billing/gift/grants/:id/subscription-link` and `rotateToken` over `POST
.../rotate-token` (F-114-e-b, each in the transaction that reads the tenant's
subscription domain), `listForUser` over `GET /api/billing/gift/grants`
(F-502-r), and `setLabel` over `PUT .../grants/:grantId/label` (F-307-x). All belong to `billing` and are written down in its `contract.gift.md`.

## Emits (events)

Through the outbox (ADR-0021); the first two also live on the buyer's `user:` channel
(`contracts/realtime/events.json`); consumer `GrantDeliveryConsumer`
(`automation/contract.outbox.md`).

| Event | Payload | When |
|---|---|---|
| `entitlement.grant.delivered` | `tenantId, userId, grantId, variantId, source, invoiceId`, `servicesUrl?` (the tenant's My services page on its proven panel host, `request/panel-url.ts`; absent with none, F-601-h) | a `pending` Grant turned `active` (F-111-d) |
| `entitlement.grant.refunded` | `tenantId, userId, grantId, invoiceId, amount, reason` | a paid Grant cancelled, its invoice refunded whole (F-111-d) |
| `entitlement.grant.delivery_delayed` | `tenantId, userId, grantId, invoiceId, ownerUserId` (the tenant's), `reason`, `waitingPanels` (a count, as a string) | a paid Grant still `pending` 5 minutes on, once (F-601-i) |
| `entitlement.grant.usage_50` / `_80` / `_95` | `tenantId, userId, grantId, period`, `percent`, `remaining` (e.g. `5.3 GB`); optional `endNotice`, `endPeriod`, `days` — a time level due with it, told as one message (F-601-f, F-601-n) | a charge crossed that share of the usage period (F-601-d), emitted by billing's metering; retention events, like the next row |
| `entitlement.grant.ends_in_7d` / `_3d` / `_1d` | `tenantId, userId, grantId, period` (= `endsAt`), `days` (whole days left) | an active Grant 7 / 3 / 1 day(s) before its end (F-601-e); retention events, like the next row |
| `entitlement.grant.ended` / `.volume_spent` / `.wallet_spent` | `tenantId, userId, grantId, period` (= the end, or the suspension's instant) | a Grant stopped: time ran out, a prepaid bag spent, a metered wallet spent (F-601-b); retention events, like the next row |
| `entitlement.grant.reactivated` | `tenantId, userId, grantId, period` (= the `suspendedAt` cleared, or the broken close's `closedAt`) | a stopped Grant runs again: a renewal or top-up revived it, or a renewal broke its standing close (F-601-k); retention events, like the next row |
| `entitlement.grant.purge_soon` / `.purge_soon_metered` | `tenantId, userId, grantId, period` (= `suspendedAt`) | a suspended Grant a day from its purge; prepaid "renew", metered "top up" (F-601-j); retention events, like the next row |
| `entitlement.grant.runs_out_soon` / `.runs_out_within_a_day` | `tenantId, userId, grantId, period` (= the usage period), `days`, `remaining` | a prepaid Grant's recent rate spends what is left within 5 days / a day, once per usage period (F-602, [contract.retention.md](contract.retention.md)); retention events, like the next row |
| `entitlement.grant.idle` | `tenantId, userId, grantId, period` (= `idleCheckAt`), `supportUrl?` | a used Grant idle 7 days, once per stretch (F-601-l, [contract.retention.md](contract.retention.md)); retention events, like the next row |
| `entitlement.grant.not_connected` / `.still_not_connected` | `tenantId, userId, grantId, period` (= `activatedAt`), `supportUrl?` | nothing consumed 24 h / 72 h after activation (F-601-c); retention events, told by `RetentionNoticeConsumer` — not on any channel |

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| catalog | a variant's quotas, `durationDays`, `billingMode`, its product's feature keys, and — when metered — its `vpn.traffic` rate card in effect at the sale (F-027-p, F-118-d) | cannot issue |
| identity | the user a Grant is issued to | cannot issue |
| tenant | the ambient tenant (ADR-0024); for a reseller's meter, its package's wholesale rate in force (F-118-n2) | refuses; `wholesale_rate_missing` |

## Consumers

| Unit | What it reads |
|---|---|
| network | `config.grantId`: a config draws on its Grant's quota (F-027); group fulfilment moves a grouped `pending` Grant to `active` (F-027-bl) |
| billing | issues a Grant for a `free_grant` coupon (F-502-l) and, later, a purchase; a refused block request suspends a spent one (F-027-x) |
| automation | holds the purge clock: `grant_config_purge` asks `purge-due` hourly (F-027-y), and the delivery clock: `grant_delivery` asks `deliver-due` every minute (F-111-d), and `grant-created` asks `grants/:grantId/deliver` on each purchase (F-114-i); tells the buyer on either event; holds the "not connected yet?" clock, `grant_unused_notice` asks `unused-due` hourly (F-601-c), and the time-threshold clock, `grant_end_notice` asks `end-due` hourly (F-601-e), and the idle clock, `grant_idle_notice` asks `idle-due` hourly (F-601-l), and the forecast, `grant_exhaustion_forecast` asks `forecast-due` hourly (F-602) |

## Guarantees (built — `entitlement-schema.int.spec.ts`)

| Rule | Held by |
|---|---|
| A tenant reads and writes only its own Grants and adjustments — never shared-read | RLS, strict |
| A Grant's user is its tenant's; its variant is the platform's or its tenant's; an adjustment and a config are their Grant's tenant's (`entitlement_tenant_mismatch`) | trigger `entitlement.same_tenant` |
| `pending → active → (suspended \| exhausted \| expired \| cancelled)`, `pending → cancelled`; only `suspended → active` goes back (`grant_status_one_way`) | trigger |
| `/sub` finds a Grant by the token's SHA-256 (lowercase hex, unique). The token is also kept sealed in `subscriptionTokenSealed`: AES-256-GCM under an HKDF key derived from the vault KEK, `{kekId, iv, authTag, ciphertext}`. Only `subscriptionTokenFor` opens it, for the Grant's own user (`grant_token_hash_shape`, `grant_token_sealed_shape`) | CHECK + unique index; D-43, ADR-0085 (reverses the hash-only call of 2026-09-14) |
| One cause issues one Grant: `(source, sourceReferenceId)` unique when set | partial unique index |
| A quota adjustment is never changed or deleted; `delta ≠ 0`; a rollover cap is 1..100 % (`quota_adjustment_is_history`) | trigger + CHECKs |
| A Grant's meter is its tenant's, one per meter; terms never change and it is never deleted, counters never below 0 (`grant_meter_terms_are_locked`, `grant_meter_counters_not_negative`); its wholesale leg all set or none, locked the same way (`grant_meter_wholesale_whole`, F-118-n2) | trigger + unique + CHECK (F-118-e) |
| `endsAt = null` is permanent; when set it is after `startsAt`. Quota sits on the Grant, never on a config (§4.6) | CHECK; schema |

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
