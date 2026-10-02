---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-10-02
---

# Contract — tenant / time zone

A topic file of `contract.md` (§10). The zone a tenant's own wall-clock
questions are answered in — a reseller's "yesterday" — and the zone of every
user of it with none of their own (TZ-1-d, ADR-0108 points 3, 7). Which zone
wins for a user is identity's:
[identity/contract.time-zone.md](../identity/contract.time-zone.md). Code:
`txnet-backend/tenant-service/src/app/time-zone/`.

## The routes

| Route | Who | Answer |
|---|---|---|
| `GET /api/tenants/:id/timezone` | a reseller: its owner, a staff member, or platform staff with `tenant.manage` (`ResellerAccess`, invariant 21). The platform's own tenant: only its staff with `tenant.manage` | `{timezone}` — an IANA name |
| `PUT /api/tenants/:id/timezone` | same, `staffWrite` | `{zone}` (strict, an IANA name) → `{timezone}`, the canonical form |

Refusals: `not_allowed` 403, `reseller_suspended` 403, `reseller_not_found`
404 (staff only), `reseller_terminated` 409; a body the schema refuses — a
fixed offset like `+03:30`, an unknown name, an extra field — is 400.

## Rules

| Rule | Why |
|---|---|
| 1. Every tenant has one, `tenant.timezone`, not null, default `PLATFORM_DEFAULT_TIMEZONE` (`Asia/Tehran`) | an existing tenant keeps the clock it had (ADR-0108 point 2) |
| 2. Stored **canonical** (`Iran` -> `Asia/Tehran`), through shared-core `canonicalTimeZone`; an offset is refused | identity rule 3: DST is the IANA database's job |
| 3. A set to the zone it already has writes nothing | a retried request is harmless |
| 4. Who may set it is who may set the operating currency ([contract.currency.md](contract.currency.md) rule 6): the platform's own tenant only by its staff with `tenant.manage` | the platform's zone is the fallback of every platform user with none |
| 5. It moves no instant. Every stored time stays UTC; only the answers to wall-clock questions change | ADR-0108 point 1 |

## Consumers

| unit | uses |
|---|---|
| panel-web | the two routes, on a reseller's workspace and the platform's `/settings` (TZ-1-e, not built) |
| identity | `tenant.timezone` through `resolveTimeZone` (TZ-1-a, built) |
