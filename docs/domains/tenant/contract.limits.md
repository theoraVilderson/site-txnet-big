---
id: tenant
layer: domain
status: active
version: 44
updated: 2026-10-01
---

# Contract — tenant: what a reseller may spend (F-019-m, ADR-0106)

A reseller acts on things the platform owns — its panels, its certificates.
Each such thing has a **limit key**, set at three levels; the most specific
level that has a row wins.

## The registry and the resolver (`shared-core/src/lib/tenant/reseller-limits.ts`)

| Key | Bounds | Code default | Highest value | Refused by |
|---|---|---|---|---|
| `user_metered_cap_max` | the number a reseller gives one user, and its tenant default | 20 | 1000 | F-019-n |
| `platform_open_grants_max` | open Grants of its users on platform panels | 500 | 1 000 000 | F-019-o |
| `admin_issues_30d_max` | services its own people issue by hand in any 30 days | 50 | 100 000 | F-019-p |
| `custom_domains_max` | its custom domains | 5 | 1000 | F-019-q |

`resellerLimitOf(tx, tenantId, key)` → `{limit, source}`; `resellerLimitsOf`
answers every key. `source` is `reseller`, `package`, `platform`, `default`,
or `exempt` (not a reseller: the platform's own tenant has no limits).

| Rule | Why |
|---|---|
| Levels: `reseller_limit` (its own) → `package_limit` (its subscription's package) → `reseller_limit_setting` (the platform's) → the code default | a tier is a package, so changing what a tier gets is one row; one reseller is still one row, removable alone |
| A row whose `value` is null is **no limit**, and stops the search; no row is "not set here" | "no limit for this reseller" is a decision, not an absence |
| The most specific wins, lower or higher | a package may be tighter than the platform; a reseller may be tighter than its package |
| A reseller with no subscription skips the package level | never an error |
| `reseller_limit` and `tenant_subscription` are strict-RLS: on the app pool, resolve in the reseller's own scope | the enforcing service is already there when it spends |
| `assertUnderLimit(key, inEffect, used)` throws `ResellerLimitReached` (`reason` `reseller_limit_reached`, `facts {key, limit, used}`) when `used ≥ limit` | only a **new** item is refused (user): lowering a limit takes nothing away |
| A limit binds the reseller's owner, its staff and its users' purchases — never the platform's staff acting on it | the enforcing row's rule (ADR-0106 point 4) |

A new key is a line in `RESELLER_LIMITS`, a line in `RESELLER_LIMIT_USAGE`,
and the one place that refuses past it. No table changes.

## What is used (`shared-core/src/lib/tenant/reseller-limit-usage.ts`, F-019-s)

| Rule | Why |
|---|---|
| `RESELLER_LIMIT_USAGE[key](tx, tenantId, now)` is **the** count of a key: every refusal compares it with the limit, and `resellerUsagesOf` shows it to the reseller | the figure on the workspace is the figure that refuses; two counts drift |
| `null` for a key that bounds a number typed, not a count: `user_metered_cap_max` | "0 used" there would be a lie |
| `platform_open_grants_max`: open Grants (`OPEN_GRANT_STATUSES`) of variants whose group holds a platform panel; `admin_issues_30d_max`: `admin_grant`s created in the last 30 days; `custom_domains_max`: its custom domains, proved or not | each is the refusing row's own definition (F-019-o, p, q) |
| The record is typed over `ResellerLimitKey` | a new key does not compile without its count |

## The platform owner's routes (`tenant-service/src/app/limits/`)

`TenantPermissionGuard` (`tenant.manage`), then the caller's tenant must be
the platform owner's (`not_platform_owner` **403**), as for packages. Every
path has three segments or more, so none is read as `GET /api/tenants/:id`.

| Route | Body | Answers |
|---|---|---|
| `GET /api/tenants/limits/settings` | — | per key: `{key, codeDefault, max, platform: {value} \| null, packages: [{packageId, name, value}], resellers: [{tenantId, slug, value, reason}]}` |
| `PUT /api/tenants/limits/settings/:key` | `{value: int ≥ 0 \| null}` | 204 |
| `DELETE` the same | — | 204 — back to the code default |
| `PUT /api/tenants/limits/packages/:packageId/:key` | `{value}` | 204 |
| `DELETE` the same | — | 204 — back to the platform's |
| `PUT /api/tenants/limits/resellers/:key` | `{tenantIds: 1..100 distinct, value, reason: 1..500}` | `{key, value, tenantIds}` |
| `POST /api/tenants/limits/resellers/:key/clear` | `{tenantIds}` | `{key, cleared}` — back to each one's package or the platform |
| `GET /api/tenants/:id/limits` (F-019-r, F-019-s) | — | `[{key, limit, source, used}]` — `resellerLimitsOf` and `resellerUsagesOf` for that reseller, on the cross-tenant pool. **Not** behind the guard: `ResellerAccess.admit(…, 'read')` lets in the reseller's owner, its team and the platform's staff; its refusals are `not_allowed` **403**, `reseller_not_found` **404** (staff only learn it), `reseller_suspended` **403**, `reseller_terminated` **409** |

| Rule | Why |
|---|---|
| An unknown key is **404** `unknown_limit`; a value past the key's highest **422** `limit_out_of_range`; an unknown package **404** `package_not_found` | a typo is never a limit |
| Several resellers are **all or none**: every id is checked to be a live reseller first; one that is not is **404** `reseller_not_found` naming it, and nothing is written | half a request applied is a state nobody asked for |
| Every write is audited in its transaction: `reseller_limit_set` / `reseller_limit_clear`, `{level, key, value}` before and after (`'unset'` = no row), against the platform's tenant, the package, or each reseller (one row each, with the reason). Clearing what has no row writes nothing | who raised whom, and why |
| Writes go through the cross-tenant pool | a reseller's row is that reseller's (RLS) |

Proved by `shared-core/.../reseller-limits.spec.ts` and
`tenant-service/src/app/limits/reseller-limits.spec.ts`.

## Not yet

The pages are F-019-r and F-019-s (`panel-web/contract.reseller-limits.md`). The unused
`tenant_restriction` was dropped by F-019-u. The four refusals are built: F-019-n,
o, p in `entitlement/contract.limits.md`, F-019-q in [contract.domains.md](contract.domains.md).
