---
id: adr-0141
status: active
updated: 2026-10-10
---

# ADR 0141 — Platform support works in a reseller under its consent

- **Status:** accepted (built by GR-1-q, GR-1-r)
- **Date:** 2026-10-10
- **Decision:** the user's (2026-10-10, the recommended option)
- **Affects units:** tenant, identity, panel-web
- **Amends:** ADR-0104 (4) (who the platform's side of a consent is),
  ADR-0135 (a seventh platform key)

## Context

GR-1-o let the platform's Support group reach the **platform's own** users by
each route's key. A reseller's users were still out of its reach: the door
admitted the platform's side of a support consent only to a holder of
`platform.tenant.manage`, the key that administers every reseller. So Support
could not help a reseller's customer even with that reseller's consent,
unless it was given far more than support needs.

The platform's support serves the **reseller**, as a store platform's support
serves the merchant, not the merchant's customers. A reseller's customers are
its own; the platform reaches them only when the reseller asks for help.

## Decision

1. **A seventh platform key, `platform.support`**: work among a reseller's
   people under that reseller's consent. Like the other six, it counts only for
   a user signed in to the platform owner's tenant, and only `SuperAdmin`'s line
   in `permissions.yaml` names it. A platform group gives it.
2. **On a reseller's people routes, `platform.support` plus the route's own key
   by name** (`user.read`, `grant.read`, `grant.repair`, …) admits a platform
   user **exactly as the platform's staff are admitted there**: only under a live
   consent of that reseller, with a `read` consent refusing writes, and every
   act written to the reseller's trail (F-117-c). With no consent there is no
   access. Without the route's key there is no access either, even with consent.
3. **Asking for consent, reading its state and withdrawing the ask** are
   open to `platform.support` as they are to `platform.tenant.manage`.
   Emergency entry stays with `tenant.emergency_access` alone (ADR-0104 (5)),
   and impersonation stays with `platform.impersonate`.
4. **The reseller list and one reseller's summary** (`GET /tenants`,
   `GET /tenants/:id`) are readable with `platform.support`, so Support can find
   the reseller it was asked to help. Everything else that configures a reseller
   keeps its key.

## Consequences

- The platform needs no broad key for support work. A leaked support account
  reaches only the resellers that consented at that moment, only for the acts
  its keys name.
- The panel's Resellers list shows for `platform.support`. A support visitor
  opens a reseller's users, where the consent banner (F-117-g) asks for access.
- Not chosen: **standing access to every reseller's users** (the reseller loses
  control of its customers' data), and **giving Support
  `platform.tenant.manage`** (administers every reseller).
