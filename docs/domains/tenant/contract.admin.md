---
id: tenant
layer: domain
status: active
version: 12
updated: 2026-09-17
---

# Contract — tenant / reseller administration

A topic file of `contract.md` (§10). The platform owner creates, lists and
reads resellers (F-018-c), and the packages it sells them (F-018-d). Before it, a tenant existed only through
`prisma/seed.js`. What a reseller does to itself is not here (F-018-h..l); a
reseller's status changes are F-018-f, its package and period F-018-e.

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

A package view: `id, name, monthlyPrice, yearlyPrice` (decimal strings or
`null`, C-02), `includedFeatureKeys, isActive`. Refusals: `not_platform_owner`
403, `package_not_found` 404, `package_name_taken` 409, `package_unpriced` 422.

| Rule | Why |
|---|---|
| A price is a base-currency decimal string, at most two places, positive; a number is refused | C-02; `DECIMAL(18,2)`; a free package is not a price |
| At least one of `monthlyPrice` / `yearlyPrice`: the schema on create, the service on an edit that clears one, and CHECK `tenant_feature_package_priced` | a package sold for one period only is allowed; one sold for none is not |
| `includedFeatureKeys` are members of `TENANT_FEATURE_KEYS` (shared-core), none repeated | the same set F-018-e turns into entitlements (C-09) |
| `usageIncludedJson` / `overageRuleJson` are not accepted and stay `{}` | D-41: no metering |
| `name` is unique; a taken name is `package_name_taken` before the transaction and on the unique index (`P2002`) | the platform owner picks a package by name |
| **No delete.** `isActive: false` deactivates and writes nothing else; `true` offers it again | a deactivated package keeps its current subscribers until their next renewal (F-019-c) |
| Each write and its audit row (`tenant_package_create` / `tenant_package_update`, target `tenant_feature_package`) are one transaction; an update audits only the fields it changed, before and after | the trail says who re-priced or withdrew a package |

## Not built here

- The panel screen: F-018-k.
- Staff, branding, custom domains, status, a tenant's package: F-018-j / h / i / f / e.
- A reseller seeing the packages it can buy: F-018-e.
- A platform-staff `X-Tenant-Id` (open question 2026-09-09): the platform
  owner reaches another tenant's rows through this service's cross-tenant
  reads, not by switching its session's tenant.
