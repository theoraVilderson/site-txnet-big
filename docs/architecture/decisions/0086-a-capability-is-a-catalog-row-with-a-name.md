---
id: adr-0086
status: active
updated: 2026-09-25
---

# ADR 0086 — a capability is a catalog row with a name

- **Status:** accepted
- **Date:** 2026-09-25
- **Affects units:** catalog, panel-web, entitlement (reads only)
- **Amends:** ADR-0049. Under that ADR a product's `featureKeys` was the only
  place a capability existed, and it had no registry.

## Context

A product lists what a Grant of it unlocks as `featureKeys` (`vpn.access`). No
table held the set of keys. The panel's picker (F-026-g) could only suggest keys
the caller's own products already used. So a fresh catalog, or any capability
not used yet, meant typing a dotted key from memory, and billing accepted any
string of that shape. A buyer's "My services" showed the raw key.

The user reported on 2026-09-25 (F-114-f) that capabilities should be picked,
not typed. They chose (D-44) a fixed platform list plus each tenant's own.

## Decision

1. **`product_capability` holds the set, like `product_category`.** A row with
   `tenantId = null` is the platform's, and every tenant sees it. A row with a
   `tenantId` is that tenant's own. Each row has a `key` (unique per tenant,
   immutable once written, derived from the name as for a product) and a
   translated `nameKey` / `descriptionKey` under `catalog-texts` (a new kind
   `capability`, ADR-0050).
2. **A product's `featureKeys` must name a capability that the product's tenant
   can see.** That is a platform row or one of its own tenant's rows. Create and
   patch refuse anything else with `capability_unknown`. `featureKeys` stays a
   `String[]` of keys. A Grant still copies the keys, so a Grant issued earlier
   never depends on a row that can change.
3. **The platform owner manages the platform list, and a reseller manages its
   own,** through the same catalog routes and the same permission
   (`catalog-permission.guard`). A reseller cannot edit or hide a platform
   capability.
4. **A capability is deleted only while nothing carries it.** If a product or a
   Grant holds its key, the refusal is `capability_in_use`. The name can always
   be edited. The key never changes.
5. **Existing keys are kept.** The migration writes one row for every distinct
   key in use. A key used only by platform products becomes a platform row, and
   any other key becomes a row of the tenant whose products use it. The name
   starts as the key, and a human names it afterwards. Nothing already sold is
   refused.
6. **Keys stay opaque to code.** No service branches on a particular key yet
   (`activeGrant` has no caller). If a service later gates on one, that key is a
   platform row, and removing it is then a code change.

## Consequences

- The panel ticks from a list with names. Typing happens only in "new
  capability", which gives a name, and the key is derived from that name.
- "My services" can show the capability's name instead of its key.
- One more translated kind in `catalog-texts`. Its drafts count toward the
  pending-translation total like any other.
- Rows: F-114-f-a (table, routes, validation, migration), F-114-f-b (the panel
  picker and "new capability"), F-114-f-c (names in "My services").
  F-114-f is done when all three are.
