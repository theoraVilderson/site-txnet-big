---
id: tenant
layer: domain
status: active
version: 17
updated: 2026-09-17
---

# Contract — tenant / reseller administration

A topic file of `contract.md` (§10). The platform owner creates, lists and
reads resellers (F-018-c), the packages it sells them (F-018-d), and which package
and period each reseller is on (F-018-e), and its status (F-018-f). Before it, a tenant existed only through
`prisma/seed.js`. What a reseller does to itself is not here (F-018-h..l); what each
status allows is [rules.md](rules.md).

Code: `auth-service/src/app/tenant/admin/`.

## Routes

All three need `tenant.manage` (`AuthGuard` + `PermissionsGuard`), and the
service admits only a caller whose own tenant is the `platform_owner`.
`SuperAdmin` holds the key through `*`; no other role is granted it
(migration `20260917001100_tenant_create`), because a reseller's owner holds
`Admin` and administration of other tenants is the platform owner's alone.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/auth/tenants` | `{slug, billingModel, owner: {fullName, username, phoneNumber, password}}`, `.strict()` | `201` a reseller view |
| `GET /api/auth/tenants` | `limit` 1-100 (default 50), `offset` | resellers, newest first, soft-deleted excluded |
| `GET /api/auth/tenants/:id` | — | one reseller view; a `platform_owner` or unknown id is `404 reseller_not_found` |

A reseller view: `id, slug, status, billingModel, createdAt`, `owner`
(`id, fullName, username, phoneNumber`, never a hash), `domains`
(`domainValue, domainType, purpose, verificationStatus`) and `billingBalance`
(the wallet's `cachedBalance` as a decimal string, C-02; `"0"` with no wallet).

Refusals, each with one status: `not_platform_owner` 403, `reseller_not_found`
404, `slug_taken` 409. A body that fails the schema is `400 validation.failed`;
a password containing the owner's profile data is `400
password.containsProfileData`.

## Creating a reseller — the rules

| Rule | Why |
|---|---|
| The caller's tenant is read on the **app** pool and a non-owner is refused before the cross-tenant pool is touched; every other read and write is on the cross-tenant pool | the rows written are another tenant's, which RLS refuses on the app pool (invariant 13, ADR-0053's order) |
| `slug` is one lower-case DNS label (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`) and not in `RESERVED_SLUGS` (`api`, `panel`, `www`, `admin`, `app`, `mail`, `sub`, `assets`, `static`, `cdn`) | it becomes the host `<slug>.$DOMAIN_NAME`; a reserved label is a host the platform serves itself |
| `billingModel` is `subscription_monthly` or `subscription_yearly` | D-41: no metering |
| `tenantType = reseller`, `status = trial` are set by the service; the body cannot name them | the platform owner is created by the seed only (invariant 1) |
| **One transaction:** `tenant`, owner `user`, an empty `tenant_billing_wallet`, one `tenant_domain` (`subdomain`, `purpose = panel`) and an `admin_audit_log` row (`tenant_create`, target `tenant`) | a half-created reseller — a tenant with no owner, or a host with no tenant — is never visible |
| `invalidateDomain(<slug>.$DOMAIN_NAME)` runs **inside** the transaction; if Redis cannot be reached the creation is refused | contract.md "Resolve tenant by claim": a cached *no tenant* on the new host would 404 it until the backstop TTL |
| The wallet is created with its defaults and no ledger entry | invariant 3: no balance is written outside `TenantBillingLedger` |
| The subdomain is not marked `verified` and routes anyway | the resolver trusts a `subdomain` as the platform issued it; invariant 5 is for `custom_domain` |
| The owner user holds the system role `Admin`; `phoneVerifiedAt` stays null | roles become per tenant with F-018-n; the platform owner types the phone, the reseller's owner proves it at first sign-in (identity invariant 6) |
| The password is the platform owner's choice, checked by `strongPasswordSchema`, stored as argon2id and never echoed — not in the answer, not in the audit row | a plaintext in a response is what invariant 8's spirit refuses |
| A slug or host already present is `slug_taken` before the transaction; a race past that check meets the unique index (`P2002`) and gets the same refusal | one reseller per slug; a double submit cannot create two |

## Packages the platform sells (F-018-d)

Code: `auth-service/src/app/tenant/packages/`. The same guard and owner check as
the routes above. `tenant_feature_package` has no `tenantId` and no RLS, so the
app pool serves it; the audit row carries the platform owner's tenant.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/auth/tenant-packages` | `{name, monthlyPrice?, yearlyPrice?, includedFeatureKeys}`, `.strict()` | `201` a package view |
| `GET /api/auth/tenant-packages` | `active` `true`/`false` (absent: all) | packages by name |
| `GET /api/auth/tenant-packages/:id` | — | one package view |
| `PATCH /api/auth/tenant-packages/:id` | any of the create fields, a price may be `null`, `isActive` | the package view after |
| `POST /api/auth/tenant-packages/:id/apply` | — | `200 {packageId, includedFeatureKeys, subscribers}` |

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
| Lock order everywhere (edit, `apply`, subscription `PUT`): the package row, then subscription / tenant rows (`subscription/package-entitlements.ts`) | an edit and a subscription change on one package serialise, never deadlock, and a tenant that just left a package is not granted its keys |

## A reseller's subscription (F-018-e)

Code: `auth-service/src/app/tenant/subscription/`. The same guard and owner
check; every read and write after it is on the cross-tenant pool.

| Route | Body | Answer |
|---|---|---|
| `PUT /api/auth/tenants/:id/subscription` | `{packageId, billingModel}`, `.strict()` | a subscription view |
| `GET /api/auth/tenants/:id/subscription` | — | a subscription view |
| `GET /api/auth/tenant-subscription-settings` | — | `{trialDays, suspensionHoldDays, renewalGraceDays}` |
| `PATCH /api/auth/tenant-subscription-settings` | `{trialDays?, suspensionHoldDays?, renewalGraceDays?}` — integers 0..365 / 0..90 / 0..30, at least one, `.strict()` | `{trialDays, suspensionHoldDays, renewalGraceDays}` |

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

## A reseller's status (F-018-f)

Code: `auth-service/src/app/tenant/status/`. The same guard and owner check;
the change runs on the cross-tenant pool. What each status allows, and how it is
enforced, is [rules.md](rules.md) (ADR-0057).

| Route | Body | Answer |
|---|---|---|
| `PUT /api/auth/tenants/:id/status` | `{status: active\|suspended\|terminated, reason?}` (1..500 chars), `.strict()` | `{tenantId, status, suspensionCause, suspendedAt, graceEndsAt, suspendedReason}` |
| `GET /api/auth/tenants/:id/status-history` | — | the newest 100 `{fromStatus, toStatus, reason, actorUserId, createdAt}` |

Refusals: `not_platform_owner` 403; `reseller_not_found` 404 (also the
platform owner's own tenant); `reseller_terminated`, `status_unchanged` 409.

| Rule | Why |
|---|---|
| **One transaction, the tenant row locked `FOR UPDATE`:** the status is read under the lock, the tenant updated, one `tenant_status_history` row and one audit row (`tenant_status_change`, target `tenant`, before/after) | two concurrent changes cannot both read the old status; the trail is never half-written |
| `suspended` stamps `suspendedAt` = now, `graceEndsAt` = now + `suspensionHoldDays` (read before the transaction) and `suspensionCause = manual`; `active` clears them and the reason; `terminated` keeps them. The renewal moves a tenant through the same `tenant-status.transition.ts` | `/sub` is served until `graceEndsAt` (D-42 (1)); a payment lifts only a `non_payment` suspension |
| `terminated` is final; `trial` cannot be set | termination is by hand and not undone; a tenant only starts in `trial` |
| **`suspended` on a reseller suspended for `non_payment` is not `status_unchanged`:** the cause becomes `manual`, `suspendedAt` / `graceEndsAt` are kept, a given reason replaces the old one, and one `suspended -> suspended` history row and the audit row are written. Suspended again when already `manual` is `status_unchanged` | a payment renews but no longer reopens a reseller closed for abuse (F-018-s, user 2026-09-17) |
| Enforcement follows the commit: the `tenant.tenant` trigger notifies, `TenantStatusListener` rewrites `tenant:status:<id>` | a rolled-back change is never enforced |
| `suspensionHoldDays` is on the platform's settings row (default 7, CHECK 0..90), edited with the same audit row as `trialDays`; it applies to suspensions started after the edit | a setting, not a deploy (D-42 (1)) |

## Not built here

- The panel screen: F-018-k.
- Staff, branding, custom domains: F-018-j / h / i. The `/sub` refusal: `network`'s service (F-027), with `tenantAllows(state, 'subscriptionLink')`.
- A reseller seeing its own subscription or the packages it can buy: not yet a row.
- Charging and renewing: `contract.billing.md` "Subscription renewal". Checking an entitlement: F-018-g.
- A platform-staff `X-Tenant-Id` (open question 2026-09-09): the platform
  owner reaches another tenant's rows through this service's cross-tenant
  reads, not by switching its session's tenant.
