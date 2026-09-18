---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-09-18
---

# Contract — tenant / feature entitlements

A topic file of `contract.md` (§10). Whether a tenant may use a feature
(F-018-g, invariant 6). Code: `txnet-backend/shared-core/src/lib/tenant/entitlements.ts`.
Which routes carry a key is decided one feature at a time, in that feature's
own row — none does yet.

## The check

`TenantEntitlements.check(tenantId, featureKey)` → `{allowed: true, source, expiresAt}`
or `{allowed: false}`; `allows()` is the same answer as a boolean. `featureKey`
is a `TenantFeatureKey` (C-09, `feature-keys.ts`).

| the tenant | answer |
|---|---|
| `platform_owner` | allowed, `source: platform_owner`, no row read — it sells the features and holds every key (user, 2026-09-18) |
| a reseller with at least one row for the key that is `isEnabled` and not expired (`expiresAt` null or after now) | allowed; any source counts (`package_included`, `addon_purchased`, `admin_granted`). The row that lasts longest is reported, a null expiry longest of all |
| a reseller with none, only disabled rows, or only expired ones | denied |
| no such tenant | denied |

Status is not judged here: `TenantStatusGuard` (`rules.md`) runs first as an
`APP_GUARD`, so a suspended tenant's write is refused before its entitlements
are read.

## Gating a route

```ts
@RequiresFeature('coupon_engine')
@Post('redeem')
redeem() {}
```

`@RequiresFeature(key)` sets the key and attaches `TenantEntitlementGuard` — a
route cannot declare a key and go unchecked. The guard answers one error:

| status | body | when |
|---|---|---|
| `403` | `{i18nKey: 'tenant.featureNotEntitled', reason: 'tenantFeatureNotEntitled'}` | the tenant in scope is not entitled, **or no tenant is in scope** — a feature is always some tenant's |

The app that gates a route provides `TenantEntitlements` and binds
`TENANT_ENTITLEMENT_READER` to its Prisma client on the cross-tenant pool
(`tenant` has no `tenantId`). No app binds it yet; the first gated feature does.

## What it does not do

- **No cache.** Two indexed reads per gated request (`tenant` by id,
  `tenant_feature_entitlement` by `(tenantId, featureKey)`). A Redis copy
  would need invalidation from every writer of those rows (subscription `PUT`,
  package edit and `apply`, renewal); add it when a measured route needs it.
- **No UI, no grant route.** Rows are written by the subscription and package
  flows (`contract.admin.md`); add-ons and grants by hand are not built.
