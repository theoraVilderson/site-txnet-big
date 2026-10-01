---
id: tenant
layer: domain
status: active
version: 51
updated: 2026-10-01
---

# Contract — tenant: what a reseller may spend (F-019-m, ADR-0106; F-019-v1, F-019-v3, F-019-v5, F-019-v6, ADR-0107)

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
| `staff_members_max` | people on its team (seats neither removed nor expired) | 20 | 1000 | F-019-t1, `contract.staff.md` rule 8 |
| `end_users_max` | its users, any status, not deleted — a new registration is refused, to the stranger without figures | 50 000 | 10 000 000 | F-019-t2, `auth-api/contract.md` register |
| `platform_traffic_gib_monthly_max` | whole GiB its users moved on platform panels this UTC month — past it no new service or renewal there until the month ends | **none** | 10 000 000 | F-019-t6, `entitlement/contract.limits.md` |
| `user_purchases_daily_max`, `user_purchases_weekly_max`, `user_purchases_monthly_max` | services **one user** buys in any 24 hours / 7 days / 30 days — per buyer, so `used` is null here | **none** | 100 000 | F-019-t7, `entitlement/contract.limits.md` |
| `campaign_sends_daily_max` | campaigns it starts sending per fixed day — a quota, counted by the engine | 10 | 1000 | F-019-v4, `notification/contract.reseller.md` |
| `bulk_job_grants_max` | services one bulk job of its people acts on — a ceiling, refused past it, `used` = the job's size | 10 000 | 100 000 | F-019-t5, `billing/contract.reseller-grants-bulk.md` |

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

## Two kinds of key, and past a quota (F-019-v1, ADR-0107 points 1, 2)

Every registry line declares `kind`. Today `campaign_sends_daily_max` is the
only `quota`; every other key is a `guard`. `RESELLER_QUOTA_KEYS` lists them.

| Rule | Why |
|---|---|
| A `quota` counts units consumed in a period and may be sold past its number; a `guard` is a safety or capacity ceiling and **always refuses** | protection is never bought with money (ADR-0107, rejected: overage on guards) |
| A guard becomes a quota only by changing its registry line (and a decision), never by a setting | the kind is what the key *is*, not a tier's option |
| `resellerOverageOf(tx, tenantId, key)` → `{mode, unitPrice, currencyCode, source}`: `stop`, or `overage` at a unit price. Levels as the number — `reseller_quota_overage` → `package_quota_overage` (its subscription's package) → `quota_overage_setting` → `stop` (`default`); `exempt` for a non-reseller. `resellerOveragesOf` answers every quota key | one place resolves it; every consumer and page reads the same answer |
| The mode resolves **apart from the number**: its own three tables, not columns on the limit rows | a reseller given a larger number keeps its package's price; a row there means "this level's number" (ADR-0106) |
| A guard key always resolves `stop` (`default`), whatever a row says | a stray row cannot sell a guard |
| `unitPrice` is a positive `Decimal(18,2)` in `currencyCode` — the **platform's**, stamped at write. It is debited from the reseller's billing wallet, which is in the platform's money, so the platform's currency change converts every level's price with it (never to nothing: one minor unit) | C-02; `billing/contract.currency-change.md` |
| No row anywhere is `stop` | refusal is what ADR-0106 did; selling is a decision |

What consumes this — counting, fixed periods, the wallet debit, the
reseller's spend cap — is billing's quota engine (F-019-v2,
[billing/contract.reseller-quota.md](../billing/contract.reseller-quota.md)).
A quota key's registry line also names its `period` (`day`, `week`, `month`).
`campaign_sends_daily_max` is consumed there, one unit per send (F-019-v4).

## Terms held for the paid period (F-019-v3, ADR-0107 point 8)

A quota key's terms — the number, `stop`/`overage`, the unit price — hold for
the subscription period the reseller paid for. Code:
`shared-core/src/lib/billing/quota-terms-lock.ts`.

| Rule | Why |
|---|---|
| Every write that can change a quota key's terms — the six number routes and the six `/overage` routes above, at any level, and a package switch (`contract.admin.md`) — first calls `lockQuotaTerms(tx, scope)` in its transaction: each reseller it reaches (named ones, the package's subscribers, or every reseller) with a subscription and no `reseller_quota_terms_lock` row for its period gets the terms in force now. A guard key is never locked | the row holds what the period started with; a second change finds it and freezes nothing |
| **The kinder part wins** (`kinderQuotaTerms`), each on its own: the larger number (no limit the largest), `overage` over `stop`, the lower price (only within one currency) | a gift reaches the reseller at once, a cut waits for the next period (user, 2026-10-01) |
| The period is the paid one — a year on a yearly plan — keyed by `currentPeriodEnd` | the renewal that moves it ends the lock with no write (user, 2026-10-01) |
| No subscription, no lock: the live terms | there is no paid period to hold |
| `quotaTermsInEffectOf` is what the engine (`quotaTermsOf`) and `GET /api/tenants/:id/limits` read; each part keeps the level it came from (`includedSource`, `overageSource`), and `lockedUntil` says until when a lock holds | the figure shown is the figure that refuses |
| A locked price converts with the platform's currency change, as every level's does | `billing/contract.currency-change.md` |

**A product's sales quota is held the same way** (F-019-v6,
`shared-core/src/lib/billing/product-quota.ts`): `lockProductQuotaTerms` writes
one lock row per window (`product:<productId>:day|week|month`) before a
listing's terms change, before it is taken off, and before a package switch;
`productQuotaTermsOf` takes the kinder part window by window. A listing taken
off is still sold, on its locked terms, until the period ends.

A paid upgrade applies at once and deletes the period's lock rows, so the new package's terms apply (F-019-v7, `contract.admin.md`).

## What is used (`shared-core/src/lib/tenant/reseller-limit-usage.ts`, F-019-s)

| Rule | Why |
|---|---|
| `RESELLER_LIMIT_USAGE[key](tx, tenantId, now)` is **the** count of a key: every refusal compares it with the limit, and `resellerUsagesOf` shows it to the reseller | the figure on the workspace is the figure that refuses; two counts drift |
| `null` for a key that bounds a number typed or a size asked, not a count: `user_metered_cap_max`, `bulk_job_grants_max` — and for a `quota`, which the engine counts: `GET …/limits` shows its `used` as the period's units, included plus sold past (F-019-v4) | "0 used" there would be a lie; a second count of a quota would drift from the engine's |
| `platform_open_grants_max`: open Grants (`OPEN_GRANT_STATUSES`) of variants whose group holds a platform panel; `admin_issues_30d_max`: `admin_grant`s created in the last 30 days; `custom_domains_max`: its custom domains, proved or not | each is the refusing row's own definition (F-019-o, p, q) |
| The record is typed over `ResellerLimitKey` | a new key does not compile without its count |

## The platform owner's routes (`tenant-service/src/app/limits/`)

`TenantPermissionGuard` (`tenant.manage`), then the caller's tenant must be
the platform owner's (`not_platform_owner` **403**), as for packages. Every
path has three segments or more, so none is read as `GET /api/tenants/:id`.

| Route | Body | Answers |
|---|---|---|
| `GET /api/tenants/limits/settings` | — | per key: `{key, kind, codeDefault, max, platform: {value} \| null, packages: [{packageId, name, value}], resellers: [{tenantId, slug, value, reason}], overage}` — `overage` null for a guard, else `{platform: O \| null, packages: [{packageId, name, ...O}], resellers: [{tenantId, slug, reason, ...O}]}`, `O` = `{mode, unitPrice: "0.50" \| null, currencyCode \| null}` |
| `PUT /api/tenants/limits/settings/:key` | `{value: int ≥ 0 \| null}` | 204 |
| `DELETE` the same | — | 204 — back to the code default |
| `PUT /api/tenants/limits/packages/:packageId/:key` | `{value}` | 204 |
| `DELETE` the same | — | 204 — back to the platform's |
| `PUT /api/tenants/limits/resellers/:key` | `{tenantIds: 1..100 distinct, value, reason: 1..500}` | `{key, value, tenantIds}` |
| `POST /api/tenants/limits/resellers/:key/clear` | `{tenantIds}` | `{key, cleared}` — back to each one's package or the platform |
| `PUT` / `DELETE /api/tenants/limits/settings/:key/overage` | `{mode: "stop"}` or `{mode: "overage", unitPrice: "0.50"}` (string, > 0, ≤ 2 places), strict | 204 — `DELETE`: back to `stop` |
| `PUT` / `DELETE /api/tenants/limits/packages/:packageId/:key/overage` | the same | 204 — `DELETE`: back to the platform's |
| `PUT /api/tenants/limits/resellers/:key/overage` | the same + `{tenantIds, reason}` | `{key, mode, unitPrice, currencyCode, tenantIds}` |
| `POST /api/tenants/limits/resellers/:key/overage/clear` | `{tenantIds}` | `{key, cleared}` |
| `GET /api/tenants/:id/limits` (F-019-r, F-019-s, F-019-v1, F-019-v2) | — | `[{key, kind, limit, source, used, overage, statement, lockedUntil}]` (`overage`: `{mode, unitPrice, currencyCode, source}`; `statement`: `{period: {kind, start, end}, includedUsed, overageQty, overageAmount}` from the engine; both null for a guard; a quota's `limit`, `source` and `overage` are the period's terms, F-019-v3; `lockedUntil` the period end a lock holds them to, else null) — `resellerLimitsOf` and `resellerUsagesOf` for that reseller, on the cross-tenant pool. **Not** behind the guard: `ResellerAccess.admit(…, 'read')` lets in the reseller's owner, its team and the platform's staff; its refusals are `not_allowed` **403**, `reseller_not_found` **404** (staff only learn it), `reseller_suspended` **403**, `reseller_terminated` **409** |

| `GET /api/tenants/limits/packages/:packageId/products` (F-019-v5) | — | `[{productId, key, nameKey, isActive, listedAt, quota: {day, week, month, overage: O}}]` by key — the platform products the package lets its subscribers sell, and each one's sales quota (F-019-v6); `404 package_not_found` |
| `PUT` / `DELETE /api/tenants/limits/packages/:packageId/products/:productId` | `{day?, week?, month?, overage?}` strict — included sales per fixed window (int 0..10 000 000, absent/`null` = no bound), `overage` as on `/overage` (absent = `stop`); the **whole** terms each time, `{}` = listed with no quota | 204 — listed or re-termed / taken off; the same terms again write nothing. Not a platform product (or none) **404** `product_not_found`; audited `package_product_set` / `package_product_clear` `{productId, quota: {day, week, month, overage} \| 'unlisted'}` against the package. A change or a removal first freezes each subscriber's terms (`lockProductQuotaTerms`, below). What reads it: catalog `contract.md` "What a reseller may sell", billing `contract.reseller-quota.md` "A product's sales" |

| `GET /api/tenants/:id/limits/products` (F-019-v10) | — | `[{productId, key, nameKey, listed, meter, windows: [{period: {kind, start, end}, included, includedUsed, overageQty, overageAmount}], overage: O}]` by product id — every platform product the reseller sells now (its package's listing, and one taken off but held this period: `listed: false`), each window counted by the engine (billing `productQuotaStatementsOf`); `[]` with no subscription. `ResellerAccess` `read`, the refusals above |
| `GET /api/tenants/:id/limits/overage-cap` (F-019-v2) | — | `{month: {kind, start, end}, cap: "50.00" \| null, spent, currencyCode}` — `ResellerAccess` `read`, the refusals above |
| `PUT` the same | `{amount: "50.00" \| null}` (≥ 0, ≤ 2 places; `0` = no overage at all; `null` removes it), strict | the same shape — `ResellerAccess` `tenantBilling`: its owner, its team, the platform's staff; audited `reseller_overage_cap_set` `{cap}` before/after in the **reseller's** log. Stamped with the platform's currency, converted by its change |

| Rule | Why |
|---|---|
| An unknown key is **404** `unknown_limit`; a value past the key's highest **422** `limit_out_of_range`; an unknown package **404** `package_not_found`; an `/overage` write on a guard key **422** `not_a_quota` | a typo is never a limit; a guard is never sold past |
| Several resellers are **all or none**: every id is checked to be a live reseller first; one that is not is **404** `reseller_not_found` naming it, and nothing is written | half a request applied is a state nobody asked for |
| Every write is audited in its transaction: `reseller_limit_set` / `reseller_limit_clear`, `{level, key, value}` before and after (`'unset'` = no row) — and for overage `reseller_overage_set` / `reseller_overage_clear`, `{level, key, overage: O \| 'unset'}` — against the platform's tenant, the package, or each reseller (one row each, with the reason). Clearing what has no row writes nothing | who raised whom, and why |
| Writes go through the cross-tenant pool | a reseller's row is that reseller's (RLS) |

Proved by `shared-core/.../reseller-limits.spec.ts` and
`tenant-service/src/app/limits/reseller-limits.spec.ts`.

## Not yet

The pages are F-019-r and F-019-s (`panel-web/contract.reseller-limits.md`). The unused
`tenant_restriction` was dropped by F-019-u. The four refusals are built: F-019-n,
o, p in `entitlement/contract.limits.md`, F-019-q in [contract.domains.md](contract.domains.md).
