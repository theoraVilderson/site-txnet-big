---
id: adr-0135
status: active
updated: 2026-10-09
---

# ADR 0135 — the platform's staff permissions are their own set

- **Status:** accepted (row AC-1-c; consumer AC-1-d)
- **Date:** 2026-10-09
- **Affects units:** identity, forward-auth, tenant
- **Decision:** the user's, 2026-10-09 — a sixth key `platform.tenant.manage`, `tenant.manage` retired, as recommended

## Context

Catalog §3.3: platform staff permissions are "a completely separate set",
never granted to a tenant role, and a platform-staff token can never be used
as a tenant token or the reverse, tested both ways. Before this, platform staff
reached every reseller and every platform route on `tenant.manage` or `*`
(F-311-aa, ADR-0058). `tenant.manage` was also the member door of every
reseller route until AC-1-e, so one key meant both "the platform administers
resellers" and "this reseller's staff member administers it". The catalog's
five keys (`platform.tenant.create`, `.plan.assign`, `.node.manage`,
`.report.read`, `.impersonate`) do not cover the general door into one
reseller — its configuration, and its people under consent (F-117-b).

## Decision

1. **The platform set is the `platform.` namespace**, and nothing else is in
   it: `platform.tenant.create`, `platform.tenant.manage` (the sixth — the
   general door into one reseller), `platform.plan.assign`,
   `platform.node.manage`, `platform.report.read`, `platform.impersonate`.
   `shared-core/.../tenant/platform-keys.ts` lists them. They sit under
   `SuperAdmin` alone in `permissions.yaml`, so the registry marks them
   platform-only and the gate's tenant ceiling (F-018-n2) excludes them.
2. **No tenant role holds one.** `RolesService` refuses any `platform.` key on
   every role it writes — they are all tenant-made — with
   `role.permissionPlatformOnly`, `*` included. The gate refuses the claim
   from a tenant-made role anyway.
3. **A platform key counts only for a caller of the platform's tenant.**
   `isPlatformStaff(reader, actor, key)` reads the caller's home tenant and
   requires `platform_owner` as well as the key. A reseller's user who somehow
   held a platform key, or `*`, is not platform staff. This is the
   tenant -> platform direction.
4. **A platform key opens no tenant surface.** No platform key is a reseller
   key or covers one, and none is in the tenant ceiling, so the whole platform
   set opens no reseller surface as one of its staff (AC-1-e's member door).
   This is the platform -> tenant direction. Platform staff reach a reseller
   only through the staff door, which AC-1-d moves onto
   `platform.tenant.manage`.
5. **`tenant.manage` is retired by AC-1-d.** The platform's routes move to
   the keys above, one route group at a time. `panel.manage` becomes
   `platform.node.manage`.

## Consequences

- Both directions are tested: `platform-keys.spec.ts` (shared-core),
  `roles.spec.ts` (the refusal) and `engine_test.go` (the gate, against the
  shipped policy file).
- Platform staff other than `SuperAdmin` can only hold a platform key through
  a named role in the policy file, because the gate checks a tenant-made role
  (`roleScope: tenant`) against the ceiling, platform tenant included. A
  platform "reports only" role therefore needs a template, or the per-user
  keys of AC-1-k. That is deliberate for now: until then, the platform's own
  tenant-made roles cannot reach the platform set.
- The migration adds the six `permission` rows and grants none.

## Alternatives rejected

- **Keep `tenant.manage` as the general door.** Fewer changes, but a key
  outside `platform.` would stay the platform's. The prefix would no longer be
  the set, and §3.3's "both ways" would carry an exception.
- **Trust the token for "platform staff".** The token says what a role holds,
  not which tenant's role it is in a way every service can check. Reading the
  home tenant costs one indexed read, and `ResellerAccess` already makes it.
