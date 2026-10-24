---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-10-24
---

# Contract — tenant / release flags

A topic file of `contract.md` (§10). How a risky feature reaches production
without reaching every tenant (OPS-1-ag, ADR-0164 point 4, chosen over a
blue/green stack): it ships off, is switched on for the platform's own tenant,
then for resellers, and off again — without a deploy. Decided with the user
2026-10-24: Postgres with a Redis cache dropped on every write; three stages
plus a per-reseller exception; an API and a panel page.

Code: `shared-core/src/lib/tenant/release-flags.ts` (the list, the rule, the
cached reader), `tenant-service/src/app/release-flags/` (the routes), panel
`/release-flags`.

## A flag

**R1 — Declared in code.** A flag is a key of `RELEASE_FLAGS` (C-09), added by
the feature it guards, in that feature's row. The list starts empty. Asking
about any other key does not compile; a route naming one answers
`404 unknown_flag`. When a flag is on for everyone and staying, the feature's
next row removes the key and its checks — a flag is a way to release, not a
setting (entitlements are the setting: `contract.entitlements.md`).

**R2 — The answer.** For a tenant and a flag, first match wins:

| | answer |
|---|---|
| the tenant has an exception (`release_flag_exception`) | its `isOn` |
| stage `everyone` | on |
| stage `platform` | on only for the platform owner's own tenant |
| stage `off`, or no `release_flag` row | off |

An exception is a reseller's only: the platform's own tenant answers by the
stage (`404 reseller_not_found` for it, a deleted one, or none).

**R3 — Asking.** `new ReleaseFlags(crossTenantPrisma, redis).isOn(key, tenantId)`
in any Nest service: one Redis read of `release-flag:<key>` (the flag whole:
stage, platform tenant, exceptions), the database on a miss, cached
`RELEASE_FLAG_CACHE_TTL_S` (300 s). The client is the cross-tenant pool:
exceptions are every reseller's rows (strict RLS, `data-model.md`). A flag
guards a feature; who may use that feature is still the route's own check.

**R4 — A switch is seen on the next request.** Every write drops
`release-flag:<key>` inside its transaction — a Redis it cannot reach refuses
the switch and nothing is written — and again after the commit, so a read that
cached the old state in between is dropped too. The TTL only bounds a lost
delete. Every service shares one key namespace, so one delete reaches them all.

**R5 — Audited.** Each write is one `audit.admin_audit_log` row in its
transaction: `release_flag_stage_set` (target `config`, the platform tenant;
`{key, stage}` before and after), `release_flag_exception_set` /
`_clear` (target the reseller; `{key, isOn}`, `'unset'` for no row).

## Routes (tenant-service)

All but `mine` take `platform.release.manage` (`@PlatformRoute`, the caller
signed in to the platform owner's tenant — ADR-0135) and are refused
`403 not_platform_owner` from any other tenant.

| route | body | answer |
|---|---|---|
| `GET /api/tenants/release-flags` | — | every declared flag: `{key, stage, exceptions: [{tenantId, isOn}]}`, in `RELEASE_FLAGS` order |
| `PUT /api/tenants/release-flags/:key` | `{stage: off \| platform \| everyone}` | `204` |
| `PUT /api/tenants/release-flags/:key/tenants/:tenantId` | `{isOn: boolean}` | `204` |
| `DELETE /api/tenants/release-flags/:key/tenants/:tenantId` | — | `204`; the stage decides again (none held: still `204`) |
| `GET /api/tenants/release-flags/mine` | — | `{<key>: boolean}` for the caller's own tenant, any signed-in caller — the panel's door to hide what a flag covers |

## The page

Panel `/release-flags` (menu: infra, platform tenant, `platform.release.manage`):
each flag's stage as three choices and its exceptions, a reseller added on or
off and removed. With no flag declared it says so. It re-reads after each of
its own writes; another admin's switch is seen on the next visit (no event:
a request-driven write, as the limits page).

## What it does not do

- No percentage roll-out and no per-user flag: a tenant is the unit (ADR-0164).
- No flag for a Go service yet: `auth-handler`, `network-service` and
  `sub-service` read none. The first that needs one reads `release-flag:<key>`
  through a Go builder (C-03) in its own row.
