---
id: tenant
layer: domain
status: active
version: 2
updated: 2026-09-20
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

## Admitting a caller to a route that names a reseller (F-066-w1)

Invariant 21, shared by every service (ADR-0064 (1)-(3)). Code:
`txnet-backend/shared-core/src/lib/tenant/reseller-access.ts`. A route that
configures a reseller names it — `/api/tenants/:id/...`, or
`/api/<service>/tenants/:tenantId/...` — and never reads it from the session or
the host; the ambient routes stay for a tenant configuring itself.

| call | answer |
|---|---|
| `ResellerAccess.admit(actor, tenantId, capability)` | `{id, slug, as: 'owner' \| 'member' \| 'staff'}`, or throws `ResellerAccessRefused` with `reason` |
| `ResellerAccess.run(actor, tenantId, capability, work)` | `admit`, then `work(reseller)` inside `runWithTenant({id})`: the app pool's RLS sees the **reseller's** rows, never the caller's. A refusal throws before `work` starts |

- `actor` is `{userId, tenantId, permissions}` as `forward-auth` sent them;
  `capability` a `TenantCapabilityName`, judged against the **reseller's**
  status matrix for the owner and a member, not at all for platform staff.
- Reasons: `not_allowed` (403; also an unknown reseller, to all but staff),
  `reseller_not_found` (404, staff only), `reseller_suspended` (403),
  `reseller_terminated` (409). Each service maps them to its own envelope.
- **Wiring.** Add `ResellerAccess` to the module's providers, and bind
  `RESELLER_ACCESS_READER` once to the service's **app pool** (tenant-service:
  `prisma.module.ts`, `useExisting: PrismaService`). Never the cross-tenant
  pool: it reads before any cross-tenant access is justified (ADR-0053).
- `work` awaits its own queries — `runWithTenant`'s rule; a Prisma promise
  returned unawaited runs after the scope has closed.
- Tests: `shared-core/src/lib/tenant/reseller-access.spec.ts`.

### Asking the door instead of guessing: `GET /api/tenants/:id/access` (F-311-e)

A *screen* has a question the routes above cannot answer: may I offer myself at
all? It cannot be derived from the session — the owner signs in in their own
platform tenant (ADR-0059), and nothing there names the reseller they own — and
reading it out of a data route's refusal answers "give me", not "may I".

| | |
|---|---|
| answer | `200 {tenantId, canRead, canWrite, reason}` — `canRead` is `read` admitted, `canWrite` is `staffWrite` admitted, `reason` one of the door's four and **only** when nothing is allowed |
| door | `ResellerAccess.admit` twice, one `now` for both. Not `run`: it reads no row of the reseller's and opens no scope |
| **never refuses** | asking whether you may is not doing it, so a refused caller gets the same 200 with `canRead: false`. Which callers may learn that a reseller exists stays the door's rule — `reason` is relayed, never widened |
| no cache | the answer is about the caller, and a seat revoked a second ago must stop administering (ADR-0033's reasoning) |

Two verdicts rather than one because the status matrix answers them
differently: a suspended reseller still reads and no longer writes
([rules.md](rules.md)), so one boolean would have to lie about one of the two.
Deciding the second from the first would mean copying the matrix out of
`ResellerAccess`, which is what invariant 21 exists to prevent.

Code: `tenant-service/src/app/access/` (`tenant-access.service.ts`,
`tenant-access.controller.ts`); tests `tenant-access.spec.ts`. Consumers:
`bot-app` (F-311-c, the reseller panel's menu row and its write buttons); a
panel navigation and F-312 / F-1531 read the same verdict.

## What it does not do

- **No cache.** Two indexed reads per gated request (`tenant` by id,
  `tenant_feature_entitlement` by `(tenantId, featureKey)`). A Redis copy
  would need invalidation from every writer of those rows (subscription `PUT`,
  package edit and `apply`, renewal); add it when a measured route needs it.
- **No UI, no grant route.** Rows are written by the subscription and package
  flows (`contract.admin.md`); add-ons and grants by hand are not built.
