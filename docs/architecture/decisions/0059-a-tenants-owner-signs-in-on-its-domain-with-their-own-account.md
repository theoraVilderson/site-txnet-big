---
id: adr-0059
status: accepted
updated: 2026-09-18
---

# ADR 0059 — A tenant's owner signs in on its domain with their own account

- **Status:** accepted 2026-09-18 with F-061-c (user)
- **Date:** 2026-09-18
- **Affects units:** identity, tenant, auth-api
- **Amends:** ADR-0024 decision 4

## Context

A person signs up on the platform's site and turns that account into a
reseller (ADR-0058 (4)); `tenant.ownerUserId` names it. The user (2026-09-18):
on the reseller's own domain the owner signs in **with that same account** and
sees its own data there — a mirror of the platform panel under their brand —
while staying the platform's customer. Neither a second account nor a copy of
their data.

ADR-0024 (4) refuses a session whose tenant differs from the surface's, because
serving one tenant's data under another's brand was a leak. For the owner of
the surface's tenant it is exactly what is wanted.

The gateway already writes `X-Tenant-Id` from the token's claim, and only
auth-service compares a claim with the host, so the whole exception lives in
auth-service's resolver.

## Decision

1. **One exception to ADR-0024 (4).** A session whose tenant differs from a
   `panel` surface's is admitted when its user is that surface tenant's
   `ownerUserId`. The request is then scoped to the **session's** tenant — the
   owner's own data — and the surface only brands it (`ResolvedTenant.brand`).
   Every other mismatch is still `403 tenant.claimMismatch`.
2. **A cookie-only request** (refresh, logout, session status) is judged the
   same way from the session its refresh cookie names. When that session is not
   the owner's, the cookie is ignored and the host alone decides, as before.
3. **Password sign-in on the surface** looks up the surface tenant's own
   accounts first; if none matches, it tries the owner's account alone, by id,
   and completes the sign-in in the owner's tenant. No other cross-tenant
   account is ever looked up.
4. **OTP sign-in and 2FA follow (3)** (F-061-d): the code is requested,
   issued, checked and the session opened in the owner's tenant, and the
   request's 202 does not change with a match. **Not in this decision:** the
   owner's administration routes (`tenant-service`, F-018-y).

## Alternatives

| Option | Why not |
|---|---|
| A second, linked account in the reseller's tenant (built and reverted 2026-09-18, `fa7801d`/`c2e5a5f`) | two accounts for one person: a copied phone drifts, and the owner's own data is not what they see on their domain |
| A membership row admitting any member on any tenant's surface | general cross-tenant access the product does not ask for; ownership is one column already |
| Moving the owner's account into the reseller's tenant | they stop being the platform's customer |

## Consequences

- `tenant.ownerUserId` becomes a security fact: the host cache carries it, and
  a change of owner must invalidate the tenant's host entries (F-018-y).
- A platform account that owns a reseller can read its own platform data from
  the reseller's domain. That is the feature, and it is limited to the owner.
