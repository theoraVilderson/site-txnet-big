---
id: tenant
layer: domain
status: active
version: 20
updated: 2026-09-18
---

# Contract — tenant / reseller administration

A topic file of `contract.md` (§10). The platform owner creates, lists and
reads resellers (F-018-c), the packages it sells them (F-018-d), and which package
and period each reseller is on (F-018-e), and its status (F-018-f). Before it, a tenant existed only through
`prisma/seed.js`. What a reseller does to itself is not here (F-018-h..l); what each
status allows is [rules.md](rules.md). A platform user buying a reseller
(F-019-h) is below, after creation: it creates through the same rows.

Code: `tenant-service/src/app/resellers/` (moved out of `auth-service` with
F-018-y, ADR-0058).

## Routes

All three need `tenant.manage` (`TenantPermissionGuard`, on the identity
`forward-auth` forwarded), and the service admits only a caller whose own
tenant is the `platform_owner`. `SuperAdmin` holds the key through `*`; no
other role is granted it (migration `20260917001100_tenant_create`), because
administration of other tenants is the platform owner's alone.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/tenants` | `{slug, billingModel, ownerUserId}`, `.strict()` | `201` a reseller view |
| `GET /api/tenants` | `limit` 1-100 (default 50), `offset` | resellers, newest first, soft-deleted excluded |
| `GET /api/tenants/:id` | — | one reseller view; a `platform_owner` or unknown id is `404 reseller_not_found` |

A reseller view: `id, slug, status, billingModel, createdAt`, `owner`
(`id, fullName, username, phoneNumber`, never a hash), `domains`
(`domainValue, domainType, purpose, verificationStatus`) and `billingBalance`
(the wallet's `cachedBalance` as a decimal string, C-02; `"0"` with no wallet).

Refusals, each with one status: `not_platform_owner` 403, `reseller_not_found`
and `owner_not_found` 404, `slug_taken` and `owner_inactive` 409. A body that
fails the schema is `400 validation.failed`.

## Creating a reseller — the rules

| Rule | Why |
|---|---|
| The caller's tenant is read on the **app** pool and a non-owner is refused before the cross-tenant pool is touched; every other read and write is on the cross-tenant pool | the rows written are another tenant's, which RLS refuses on the app pool (invariant 13, ADR-0053's order) |
| `slug` is one lower-case DNS label (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`) and not in `RESERVED_SLUGS` (`api`, `panel`, `www`, `admin`, `app`, `mail`, `sub`, `assets`, `static`, `cdn`, `edge`) | it becomes the CNAME target `<slug>.edge.$DOMAIN_NAME` (ADR-0063); a reserved label is a host the platform serves itself (`edge` is the CNAME-target zone) |
| `billingModel` is `subscription_monthly` or `subscription_yearly` | D-41: no metering |
| `tenantType = reseller`, `status = trial` are set by the service; the body cannot name them | the platform owner is created by the seed only (invariant 1) |
| **The owner is an existing user** — `ownerUserId` names a user of the platform owner's tenant, not soft-deleted (else `owner_not_found`), `active` (else `owner_inactive`). No `identity.user` row is written or changed, and the owner's role is untouched | a person signs up on the platform and becomes a reseller while staying its customer (ADR-0058 (4)); what the owner may do is ADR-0059 and `ResellerAccess` (F-061-h, invariant 21), not a role here |
| The same rows serve a reseller made by hand and F-019-h's purchase (`resellers/reseller-rows.ts` `writeReseller`) | one way to create a reseller (user, 2026-09-18) |
| **One transaction:** `tenant`, an empty `tenant_billing_wallet`, one `tenant_domain` row (`subdomain`, `purpose = panel`): the reseller's own CNAME target `<slug>.edge.$DOMAIN_NAME` — no `<slug>.$DOMAIN_NAME` (ADR-0063) — and an `admin_audit_log` row (`tenant_create`, target `tenant`) | a half-created reseller — a tenant with no wallet, or a host with no tenant — is never visible |
| `invalidateTenantOwner` (shared-core) runs **inside** the transaction — the new tenant's `tenant:id:*` and both hosts' `tenant:host:*` entries; if Redis cannot be reached the creation is refused | contract.md "Resolve tenant by claim": a cached *no tenant* on the new host would 404 it until the backstop TTL. The entry carries `ownerUserId` (ADR-0059), so **every write of `ownerUserId` calls the same function** (invariant 20, F-061-k) |
| The wallet is created with its defaults and no ledger entry | invariant 3: no balance is written outside `TenantBillingLedger` |
| The target is not marked `verified`, resolves, and serves nothing | the resolver trusts a `subdomain` as the platform issued it (invariant 5 is for `custom_domain`); ADR-0063 closes every path on a CNAME target |
| A slug or host already present is `slug_taken` before the transaction; a race past that check meets the unique index (`P2002`) and gets the same refusal | one reseller per slug; a double submit cannot create two |

## A platform user buys a reseller (F-019-h, ADR-0061)

Code: `tenant-service/src/app/purchase/`. No permission key: any signed-in
user of the platform owner's tenant; anyone else is `403 not_platform_user`,
read on the app pool before the cross-tenant pool is touched.

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/tenants/purchase/mine` | — | `{reseller}`: the caller's live reseller (`id, slug, status, billingModel, package {id, name}, currentPeriodEnd, domains`), `null` when none — a 200 either way (F-019-l) |
| `GET /api/tenants/purchase/packages` | — | active packages by name: `id, name, monthlyPrice, yearlyPrice, includedFeatureKeys` |
| `GET /api/tenants/purchase/slug` | `name` 1..100, `.strict()` | `{slug}` — a suggestion, checked again by the purchase |
| `POST /api/tenants/purchase` | `{packageId, billingModel, name, slug?}`, `.strict()` | `201` a reseller view + `packageId, currentPeriodEnd, charged, walletBalance` |

Refusals: `not_platform_user` 403; `package_not_found` 404; `buyer_inactive`,
`already_reseller`, `slug_taken`, `insufficient_balance`, `wallet_changed` 409;
`package_inactive`, `package_not_sold_for_period` 422.

| Rule | Why |
|---|---|
| **Paid from the buyer's wallet; the first period is paid and the reseller `active` at once**; `trial` stays the platform owner's hand-made path | a free purchase lets one account hold many slugs (user, 2026-09-18) |
| **One transaction on the cross-tenant pool**, the package `FOR SHARE` first: `writeReseller`'s rows, the buyer's `wallet` debit (`reseller_purchase`, `referenceId` = the new tenant, `tenantId` = the platform owner), the price credited to the reseller's billing wallet (`reseller_purchase`) and charged from it (`subscription_charge`, the renewal's reference for the period starting now), the subscription ending one period on (`addBillingPeriod`), the package's `package_included` keys, and `trial` -> `active` (history `reseller_purchased`, actor the buyer) | money never leaves a wallet without a reseller; a short wallet throws inside the transaction, so nothing is refunded (ADR-0061) |
| **One live reseller per user**: one they own that is not `terminated` or deleted (`liveReseller`, the same one `mine` answers) is `already_reseller`, checked before and again inside the transaction; two purchases racing meet at the wallet's version guard (`wallet_changed`) | `GET /auth/me` and the panel assume one tenant per owner (user, 2026-09-18) |
| **The slug:** sent, it is the buyer's own (`slugSchema`, the create's rules) and a held one is `slug_taken`; absent, the one `name` suggests. A suggestion transliterates Persian to Latin, becomes one DNS label of at most 50 characters (`reseller` when nothing is left), then takes the first of `base`, `base-2` … `base-20` neither reserved nor held, else a random suffix. Fixed after creation | close to the name and editable before buying; renaming would move both hosts and break a CNAME to `<slug>.edge` (user, 2026-09-18) |
| The package must be active and priced for the period, read again under its lock | a deactivated package takes no new subscriber (F-018-d) |
| Rate limits per user over 15 minutes: `RESELLER_PURCHASE_READ` for `mine`, the package list and the suggestion together (`RESELLER_PURCHASE_READ_RATE_LIMIT`, default 120), `RESELLER_PURCHASE_WRITE` for the purchase (`RESELLER_PURCHASE_WRITE_RATE_LIMIT`, default 10); over it is `429` | the suggestion is asked as the name is typed; a purchase moves money. Tunable without a rebuild (F-087) |

## Packages the platform sells (F-018-d)

Code: `tenant-service/src/app/packages/` (moved out of `auth-service` with
F-018-u, ADR-0058). The caller is the identity `forward-auth` forwarded, holding
`tenant.manage`, and the owner check is the service's own, as above.
`tenant_feature_package` has no `tenantId` and no RLS, so the app pool serves
it; the audit row carries the platform owner's tenant.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/tenant-packages` | `{name, monthlyPrice?, yearlyPrice?, includedFeatureKeys}`, `.strict()` | `201` a package view |
| `GET /api/tenant-packages` | `active` `true`/`false` (absent: all) | packages by name |
| `GET /api/tenant-packages/:id` | — | one package view |
| `PATCH /api/tenant-packages/:id` | any of the create fields, a price may be `null`, `isActive` | the package view after |
| `POST /api/tenant-packages/:id/apply` | — | `200 {packageId, includedFeatureKeys, subscribers}` |

A package view: `id, name, monthlyPrice, yearlyPrice` (decimal strings or
`null`, C-02), `includedFeatureKeys, isActive`. Refusals: `not_platform_owner`
403, `package_not_found` 404, `package_name_taken` 409, `package_price_in_use` 409, `package_unpriced` 422.

| Rule | Why |
|---|---|
| A price is a base-currency decimal string, at most two places, positive; a number is refused | C-02; `DECIMAL(18,2)`; a free package is not a price |
| At least one of `monthlyPrice` / `yearlyPrice`: the schema on create, the service on an edit that clears one, and CHECK `tenant_feature_package_priced` | a package sold for one period only is allowed; one sold for none is not |
| Clearing a price while a subscriber that is not terminated is on that period is `package_price_in_use`, checked under the package's `FOR UPDATE` | the renewal would have nothing to charge (F-019-c, user 2026-09-17) |
| `includedFeatureKeys` are members of `TENANT_FEATURE_KEYS` (shared-core), none repeated | the same set F-018-e turns into entitlements (C-09) |
| `usageIncludedJson` / `overageRuleJson` are not accepted and stay `{}` | D-41: no metering |
| `name` is unique; a taken name is `package_name_taken` before the transaction and on the unique index (`P2002`) | the platform owner picks a package by name |
| **No delete.** `isActive: false` deactivates and writes nothing else; `true` offers it again | a deactivated package takes no new subscriber; its current ones keep renewing on it (F-019-c, user 2026-09-17) |
| Each write and its audit row (`tenant_package_create` / `tenant_package_update`, target `tenant_feature_package`) are one transaction; an update audits only the fields it changed, before and after | the trail says who re-priced or withdrew a package |
| **A key added to `includedFeatureKeys` reaches every current subscriber in the edit's transaction** (a `package_included` entitlement, unless held); **a removed key stays until the subscriber's renewal** (F-019-c re-copies the package) | a subscriber gets a new feature at once and never loses one mid-period it paid for (user, 2026-09-17, F-018-o) |
| **`apply` forces the list now:** every subscriber's `package_included` entitlements are replaced by the package's, removals included; one audit row `tenant_package_apply` with the keys and the tenant ids. An inactive package may be applied | sometimes a removal must be immediate (user, 2026-09-17) |
| Lock order everywhere (edit, `apply`, subscription `PUT`): the package row, then subscription / tenant rows (`package-entitlements.ts`) | an edit and a subscription change on one package serialise, never deadlock, and a tenant that just left a package is not granted its keys |

## A reseller's subscription (F-018-e)

Code: `tenant-service/src/app/subscription/` (moved with F-018-v, ADR-0058).
The same permission and owner check as the package routes; every read and write
after it is on the cross-tenant pool.

| Route | Body | Answer |
|---|---|---|
| `PUT /api/tenants/:id/subscription` | `{packageId, billingModel}`, `.strict()` | a subscription view |
| `GET /api/tenants/:id/subscription` | — | a subscription view |
| `POST /api/tenants/:id/subscription/grace` | `{days, reason}` — integer 1..90, 1..500 chars, `.strict()` | `200 {tenantId, currentPeriodEnd, graceUntil, status, suspensionCause}` |
| `GET /api/tenant-subscription-settings` | — | `{trialDays, suspensionHoldDays, renewalGraceDays}` |
| `PATCH /api/tenant-subscription-settings` | `{trialDays?, suspensionHoldDays?, renewalGraceDays?}` — integers 0..365 / 0..90 / 0..30, at least one, `.strict()` | `{trialDays, suspensionHoldDays, renewalGraceDays}` |

A subscription view: `tenantId, packageId, packageName, billingModel,
currentPeriodEnd, startedAt, includedFeatureKeys`. Refusals:
`not_platform_owner` 403; `reseller_not_found`, `subscription_not_found`,
`package_not_found` 404; `reseller_terminated` 409; `package_inactive`,
`package_not_sold_for_period` 422.

| Rule | Why |
|---|---|
| One `tenant_subscription` row per tenant: the package and `currentPeriodEnd`. The period is `tenant.billingModel`, which a `PUT` sets | one place for the period; F-018-c already writes it |
| **The first package starts the trial:** `currentPeriodEnd` = now + `trialDays`. Creating a reseller starts nothing | without a package there is nothing to try (user, 2026-09-17) |
| **A later `PUT` keeps `currentPeriodEnd`** — a new package or period is charged at that renewal. No proration | no charge here; the first charge and every renewal are `contract.billing.md` "Subscription renewal" (user, 2026-09-17) |
| The package must have a price for the period asked | a package may be sold for one period only (F-018-d) |
| An inactive package is refused unless the tenant is already on it | a deactivated package keeps its subscribers and takes no new ones |
| A `terminated` reseller is refused; `trial`, `active`, `suspended` are not | what each status blocks is F-018-f |
| **One transaction, the tenant row locked `FOR UPDATE`:** the subscription, `billingModel` if changed, the tenant's `package_included` entitlements deleted and one per `includedFeatureKeys` written (`isEnabled`, no `expiresAt`), and an audit row (`tenant_subscription_set`, target `tenant`, the reseller's tenant) | two concurrent `PUT`s cannot interleave the replace; entitlements from `addon_purchased` / `admin_granted` are never touched |
| The keys are read under a shared lock on the package | a concurrent package edit is wholly before or after the `PUT` (F-018-o) |
| `trialDays` is the platform's one `tenant_subscription_setting` row (`id = 1`, CHECK 0..365, default 14), edited with an audit row (`tenant_subscription_setting_update`); it applies to trials started after the edit. `renewalGraceDays` (CHECK 0..30, default 3) is on the same row and read by each renewal | a setting the platform owner changes without a deploy (user, 2026-09-17) |

### More time to pay (F-019-g)

| Rule | Why |
|---|---|
| `graceUntil` = the latest of now, the renewal's deadline (`currentPeriodEnd` + `renewalGraceDays`) and an earlier `graceUntil`, plus `days`; the renewal suspends at the later of the two (`renewalDeadline`) | a grant never shortens time already given, and a second grant adds to the first |
| **No money moves:** no ledger entry, `currentPeriodEnd` unchanged; a paid renewal clears `graceUntil` | a manual credit would record money that never arrived; the period is still owed (user, 2026-09-17) |
| A `non_payment` suspension is lifted at once (`rules.md` #15; history reason = the given reason, actor the admin); a `manual` one stays; `trial` / `active` keep their status | reactivating by hand was undone by the next sweep |
| One transaction, the tenant row `FOR UPDATE`: the subscription, the status change if any, one audit row (`tenant_subscription_grace`, target `tenant`, before/after with `days` and `reason`) | the renewal holds the same lock, so a sweep sees the grant wholly or not at all |
| `terminated` is `reseller_terminated` 409; no subscription is `subscription_not_found` 404 | there is no renewal to postpone |

## A reseller's status (F-018-f)

Code: `tenant-service/src/app/status/` (moved with F-018-w, ADR-0058). The same
guard and owner check; the change runs on the cross-tenant pool. What each status
allows, and how it is enforced, is [rules.md](rules.md) (ADR-0057).

| Route | Body | Answer |
|---|---|---|
| `PUT /api/tenants/:id/status` | `{status: active\|suspended\|terminated, reason?}` (reason 1..500 chars), `.strict()` | `{tenantId, status, suspensionCause, suspendedAt, graceEndsAt, suspendedReason}` |
| `GET /api/tenants/:id/status-history` | — | the newest 100 `{fromStatus, toStatus, reason, actorUserId, createdAt}` |

Refusals: `not_platform_owner` 403; `reseller_not_found` 404 (also the
platform owner's own tenant); `reseller_terminated`, `status_unchanged` 409.

| Rule | Why |
|---|---|
| **One transaction, the tenant row locked `FOR UPDATE`:** the status is read under the lock, the tenant updated, one `tenant_status_history` row and one audit row (`tenant_status_change`, target `tenant`, before/after) | two concurrent changes cannot both read the old status; the trail is never half-written |
| `suspended` stamps `suspendedAt` = now, `graceEndsAt` = now + `suspensionHoldDays` (read before the transaction) and `suspensionCause = manual`; `active` clears them and the reason; `terminated` keeps them. The renewal moves a tenant through the same `tenant-status.transition.ts` | `/sub` is served until `graceEndsAt` (D-42 (1)); a payment lifts only a `non_payment` suspension |
| `terminated` is final; `trial` cannot be set | termination is by hand and not undone; a tenant only starts in `trial` |
| **`suspended` on a reseller suspended for `non_payment` is not `status_unchanged`:** the cause becomes `manual`, `suspendedAt` / `graceEndsAt` are kept, a given reason replaces the old one, and one `suspended -> suspended` history row and the audit row are written. Suspended again when already `manual` is `status_unchanged` | a payment renews but no longer reopens a reseller closed for abuse (F-018-s, user 2026-09-17) |
| **This service does not know campaigns exist.** A suspension leaves the reseller's `sending` campaigns running; stopping them is a second call by the caller, to notification's owner-only `POST notifications/campaigns/tenants/:tenantId/stop` (F-018-x), after the heads-up `GET notifications/campaigns/sending-summary/:tenantId` | ADR-0058 (5), F-018-w: the outbox path this replaced could dead-letter out of sight, and put campaigns into tenant administration |
| Enforcement follows the commit: the `tenant.tenant` trigger notifies, `TenantStatusListener` rewrites `tenant:status:<id>` | a rolled-back change is never enforced |
| `suspensionHoldDays` is on the platform's settings row (default 7, CHECK 0..90), edited with the same audit row as `trialDays`; it applies to suspensions started after the edit | a setting, not a deploy (D-42 (1)) |

## Not built here

- The panel screen is `panel-web`'s `/resellers` (F-018-k, [contract.resellers.md](../../interfaces/panel-web/contract.resellers.md)); it only calls the routes above.
- Staff, branding, custom domains: F-018-j / h / i. The `/sub` refusal: `network`'s service (F-027), with `tenantAllows(state, 'subscriptionLink')`.
- A reseller seeing its own subscription or the packages it can buy: not yet a row.
- Charging and renewing: `contract.billing.md` "Subscription renewal". Checking an entitlement: F-018-g.
- A platform-staff `X-Tenant-Id` (open question 2026-09-09): the platform
  owner reaches another tenant's rows through this service's cross-tenant
  reads, not by switching its session's tenant.
