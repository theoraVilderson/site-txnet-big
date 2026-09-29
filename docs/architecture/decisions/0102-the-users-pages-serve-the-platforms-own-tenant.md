---
id: adr-0102
status: accepted
updated: 2026-09-28
---

# ADR 0102 — the users-admin routes serve the platform's own tenant, to its staff

- **Status:** accepted
- **Date:** 2026-09-28 (user, D-55; row F-311-aa)
- **Affects units:** tenant (`ResellerAccess`), identity, billing
- **Amended by:** [ADR-0104](0104-platform-staff-see-a-resellers-people-only-with-its-consent.md) — platform staff reach a reseller's people only with its consent
- **Amends:** ADR-0064 (1)-(3) — the door names a reseller; here, on one family
  of routes, it may also name the platform

## Context

The users pages (F-311-a list/search/block, F-311-f..u a user's services and
every admin act on them) sit behind `ResellerAccess`, which finds only
`tenantType = reseller`. The platform's own direct users — people who
registered on the platform's domain — had no page at all. Asked whether they
get a separate page or the same one (D-55), the user chose **one page for every
tenant**: a second page would build every act twice and drift from the first.

## Decision

1. **Opt-in, per route family.** `ResellerAccess.admitIncludingPlatform` /
   `runIncludingPlatform` also find the `platform_owner` tenant; `admit` / `run`
   are unchanged. Only the users-admin services call the new pair —
   `reseller-users.service.ts` (auth), `reseller-user-grants.service.ts` and
   `grant-bulk-job.ts` (billing). Configuring the platform (its domains, brand,
   catalog, gateways, staff) is not a reseller route's job and stays refused
   there (`reseller_not_found` to staff).
2. **Platform staff only.** The platform's tenant is admitted to a caller of
   the platform tenant holding `tenant.manage` (or `*`), as `as: 'staff'`, and
   to nobody else — its `ownerUserId` without the permission, a seat on it, a
   reseller's owner — who gets `not_allowed` and learns nothing.
3. **Same scope rule.** The work runs in `runWithTenant(<platform>)`, so RLS
   answers "whose users" exactly as for a reseller; no query gains a
   `tenantId`. The status matrix is not applied (staff are never judged by it),
   and a reseller named on these routes is answered exactly as `admit` would.

## Consequences

- One code path serves every tenant's users; F-311-ab (the panel's Users
  entry) needs no second page.
- Platform staff are users of the platform tenant, so they appear in its list
  and can block each other; `cannot_block_self` is the only guard. Whether a
  staffer may block a peer or the platform's owner is not decided here.
- A future users-admin act must call the `IncludingPlatform` pair to reach the
  platform's users; calling `run` keeps it reseller-only, which fails safe.
