---
id: adr-0162
status: accepted
updated: 2026-10-23
---

# ADR 0162 — A reseller registers its own router for an import in place

- **Status:** accepted (built by F-1601-g; F-1601-c's page uses it)
- **Date:** 2026-10-23
- **Decision:** the user's (2026-10-23)
- **Affects units:** network (`contract.registration.md`), entitlement
  (`contract.import-in-place.md`), panel-web (`contract.migration.md`)
- **Amends:** ADR-0080 decision 2 and `network/open-questions.md` 2026-09-23
  ("platform panels only", decided 2026-09-27), for the families below only.

## Context

An import in place (ADR-0160) reads the reseller's own User Manager router
and leaves each user on it. Billing accepts only the tenant's own panel for
it (`panel.tenantId` = the run's tenant, F-1601-b1). Registration was
owner-only and writes only platform panels, so no reseller could own a
router, and the import page had nothing to offer. ADR-0095 already made a
tenant's panel safe to dial: it never gets the operator's egress allowlist.

## Decision

1. **A reseller registers a panel of a family imported in place**
   (`isInPlaceFamily`: `mikrotik_user_manager` today, IBSng with F-1602).
   Every other family stays owner-only, on the systems page.
2. **The panel is the path's tenant's** (ADR-0064): `ownershipType tenant`,
   `tenantId` the reseller, the vault reference under the reseller. Never
   the session's tenant, so the owner acting in a reseller's workspace
   registers the reseller's router, not a platform one.
3. **The door is the import's**: `ResellerAccess` on `migration.manage`,
   `staffWrite` to register or re-enter a login, `read` to list. Its only use
   today is the import. A key of its own comes with the first family that is
   not imported in place.
4. **The family decides the declaration**, not the form: User Manager is
   `pull` / `cumulative` (ADR-0161), role `active`. Its region names nothing
   (no group places a user on it, ADR-0160 decision 6) and is a named
   constant. The form asks a name, the address and the login only.
5. **The same connection test and verdict** as any panel
   (`contract.registration.md`). The verdict already reaches the panel's
   tenant (`network.panel.tested` on its `tenant:` channel).
6. **Dialed through the bare guard** (ADR-0095 decision 1). A router on a
   private address cannot be used; that is ADR-0095's revisit trigger.

Not decided here: editing, retiring or deleting a reseller's router, putting
it in a group, or selling new users on it.

## Consequences

- Positive: a reseller imports without waiting on the platform owner. IBSng
  (F-1602) needs nothing more.
- Negative / accepted cost: a reseller's mistaken router stays until
  retiring one is built. An address is still registered once, platform-wide.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| The owner registers it for the reseller on the systems page | every reseller's import waits on the owner; does not scale with resellers |
| The import page registers it as a side effect of the run | a panel would be born and die with a run, though its users stay on it after the commit |

## Revisit trigger

A reseller asks to register a family that is not imported in place.
