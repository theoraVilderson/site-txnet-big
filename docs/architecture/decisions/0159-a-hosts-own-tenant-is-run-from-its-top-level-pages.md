---
id: adr-0159
status: accepted
updated: 2026-10-23
---

# ADR 0159 — A host's own tenant is run from its top-level pages, and the platform has every page a reseller has

- **Status:** accepted (built by TC-1-b … TC-1-i)
- **Date:** 2026-10-23
- **Decision:** the user's (2026-10-23), the open points on the agent's recommendation, accepted the same day
- **Affects units:** panel-web, entitlement, audit, tenant, automation
- **Amends:** ADR-0064 (4), UX-2-a's single «نمایندگی» button on a reseller's
  own domain (`contract.reseller-workspace.md` rule 2), F-061-n's "`/reseller`
  is 404 on the platform's panel" (`SelfWorkspace`). ADR-0064 (1)–(3) stand.

## Context

The panel had two ways to run a tenant. The platform ran itself from
top-level pages in N1's sections. A reseller ran itself from `/reseller/…`,
drawn under one «نمایندگی» button even on its own domain, where it is the
only tenant being run. The platform had no twin of six reseller pages:
migration, access log, branding, domains, bot and the tenant settings. The
user asked why the platform could not import users (2026-10-23) and wanted
two things: every capability a reseller has, the platform has too; and on
a reseller's domain its pages sit in the sidebar like the platform's, not
under the word «نمایندگی». ADR-0142 already made the platform a tenant like
any other, so the services were ready. Only the panel kept the two apart.

## Decision

1. **The host's tenant is the one its top-level pages run.** On the
   platform's panel that is the platform. On a reseller's verified domain it
   is that reseller, whoever signs in there: the owner (a platform user,
   ADR-0059) or a staff seat. The panel works it out in one place, which
   generalises `useSelfResellerId`. Pages hand that id to the path-scoped
   routes of ADR-0064 (1). The services still decide every call
   (invariant 21).
2. **One menu model for any tenant admin.** Each N1 entry declares the
   tenant kinds it serves: `platform`, `reseller` or both. On its own domain
   a reseller's pages are top-level entries in N1's sections. No
   «نمایندگی» button, and no "reseller · slug" tag, because the host already
   says whose pages they are.
3. **Parity is a test, not a promise.** A spec walks every reseller page and
   fails unless the page serves the platform too or appears on a written
   exclusion list with its reason. Excluded today: setup (the go-live steps
   of D-01/D-03), the reseller's wholesale billing with the platform, and the
   handoff.
4. **Another tenant's pages stay under one button named for it.** On the
   platform's panel, an owner's own reseller is not the host's tenant. It
   keeps the one «نمایندگی» button and `/reseller/…` there (user,
   2026-10-08). Platform staff keep `/my-resellers/:id/…` for any reseller,
   tagged. On a reseller's domain `/reseller/…` redirects to its top-level
   twin, and `SelfWorkspace` is deleted with the old paths (C-21).
5. **The platform's twins, each in its own unit:**
   - **Migration:** an import into the platform places on its own panels
     and products and charges no wholesale (TC-1-d).
   - **Access log:** the platform tenant's sign-in log (TC-1-e).
   - **Branding:** the platform's brand is its `tenant_branding` row, as any
     tenant's. Whatever env holds today seeds the row once and is then
     deleted (TC-1-f).
   - **Domains:** the platform's panel, sub and api hosts are shown read-only
     while Traefik takes them from env. Editing them waits for the hosts to
     leave env (TC-1-g).
   - **Bot:** the platform's bot settings live on the same page, with the
     token in the vault like a reseller's. Env seeds it once (TC-1-h).
   - **Settings:** one tenant-settings page for the platform, merged with
     `/settings?tab=workspace` (TC-1-i).

## Consequences

- Positive: a new reseller page reaches the platform the day it lands, or the
  parity spec says why not. A reseller's admin sees the same shape the
  platform's sees.
- Negative / accepted cost: id-less top-level routes now mean "the host's
  tenant", so the same address shows different data on two hosts. That is
  the point, and the services admit by the path's tenant, not the address.
- What this forecloses: a reseller page built only under `/reseller/…`.

## Alternatives rejected

- **Only add migration to the platform.** Cheap today, but the next reseller
  page reopens the gap, and nothing would say so.
- **Keep the one button on the reseller's own domain.** The user rejected it
  (2026-10-23): it labels the only tenant on that host as if it were a
  guest.
- **Run the platform from `/my-resellers/<platform id>/…`.** It puts the id
  in the address, which the user rejected for owners on 2026-10-08, and
  tags the platform as a reseller.

## Revisit trigger

A third tenant kind, or a host that runs more than one tenant.
