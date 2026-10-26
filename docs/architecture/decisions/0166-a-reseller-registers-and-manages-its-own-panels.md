---
id: adr-0166
status: accepted
updated: 2026-10-26
---

# ADR 0166 — A reseller registers and manages its own panels

- **Status:** accepted (built by BYO-1)
- **Date:** 2026-10-26
- **Decision:** the user's (2026-10-26): «مثل پلتفرم بتونه ثبت کنه، اگه محدودیت نیاز داره واسش هم بزار»
- **Affects units:** billing (`contract.systems.md`, `contract.panel-groups.md`), tenant (`contract.limits.md`, reseller keys), panel-web (systems page)
- **Amends:** ADR-0080 decision 2 and ADR-0162 decision 1 (its revisit trigger: "a reseller asks to register a family that is not imported in place"). Catalog §7.2 (Bring Your Own Node).

## Context

Registration and the whole systems surface were the platform owner's
(`panelScopeOf` refused every other tenant). ADR-0162 opened one door — a
reseller's own User Manager router, for an import in place. A reseller who
runs its own Marzban or 3x-ui servers still had to ask the owner, and the
owner's panels were the only place a reseller's product could be placed. The
preconditions were built first: the dial guard (F-027-dl) and an egress
allowlist that a tenant's panel never gets (F-027-dr, ADR-0095).

## Decision

1. **Every family with a driver**, on the systems surface's own routes and
   service code, mirrored under `/api/billing/tenants/:tenantId/systems/…`.
2. **The scope is the path's tenant** (ADR-0064): `panelScopeOf` answers
   `{ownershipType: tenant, tenantId}` for a reseller and the platform's scope
   for the owner, as ADR-0080 decision 2 foresaw. A reseller sees and writes
   only its own panels, groups, members and inbounds; a platform panel is
   never named to it (`inScope`).
3. **The door is `ResellerAccess` on a new key, `node.manage`** — the
   reseller twin of `platform.node.manage`, grantable to its staff.
4. **Bounded by `panels_max`** (ADR-0106's registry): code default 20, max
   1000, counting its live panels; a new registration past it is refused,
   lowering it takes nothing away. The import's router counts too.
5. **A group never mixes owners** (user, 2026-10-26): a reseller's group holds
   its own panels only, the platform's holds the platform's. A sale on a
   reseller's group is never charged wholesale (F-118-n6 already keys on the
   panel's `ownershipType`).
6. **Unchanged:** the bare dial guard (no private address), `report_only` for
   orphans on a reseller's panel (network open question 2026-09-23), the
   connection test and its verdict on the tenant's channel.

## Consequences

- Positive: a reseller with its own servers sells without the owner; the
  platform's capacity is not its bottleneck.
- Negative / accepted cost: the collector dials addresses resellers chose (the
  guard bounds where); each reseller panel costs collection budget, which
  `panels_max` bounds.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| The owner registers a reseller's panels for it | every reseller waits on the owner; does not scale |
| Mixed groups (own + platform panels) | wholesale would have to be priced per byte by panel inside one group; the user chose separation |
| No limit | collection load grows unbounded with resellers, and a limit is harder to add later |

## Revisit trigger

A reseller needs a panel on a private address, or a group across owners.
