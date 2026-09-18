---
id: adr-0059
status: accepted
updated: 2026-09-18
---

# ADR 0059 — A reseller's owner is a linked account in the reseller's tenant

- **Status:** accepted 2026-09-18 with F-061-c (user)
- **Date:** 2026-09-18
- **Affects units:** identity, tenant, auth-api

## Context

A person signs up on the platform's own site and becomes a reseller by buying
(ADR-0058 (4)); they stay a customer of the platform. Their reseller panel is on
the reseller's host, and there `TenantGuard` refuses any session whose tenant is
not the host's (ADR-0024 (4), ADR-0025). The user (2026-09-18): the owner must
be able to sign in **on the reseller's own host**, and also **get in from the
platform site**.

`identity.user` is a tenant-scoped model (`TENANT_SCOPED_MODELS`), and a
session is one user in one tenant — its access token carries one `tenantId`,
which the gateway and every service read.

## Decision

1. **The owner has an account in the reseller's tenant**, an ordinary
   `identity.user` row whose `credentialUserId` names their platform account.
   Its role is that tenant's (system `Admin` until F-018-n). A session on the
   reseller's host is for this account, so ADR-0024 (4), `TenantGuard`, the
   access-token claims and the gateway do not change.
2. **Its credentials are the linked account's.** It stores no `passwordHash`
   (the column is nullable for this reason alone). A password, and whether 2FA
   applies, are read from the account `credentialUserId` names, over
   `CrossTenantPrismaService`. One password, set in one place.
3. **Signing in on the reseller's host** takes the platform account's
   password, or an OTP to the account's own phone (copied at creation).
   A linked account that is inactive, deleted, or whose linked account is,
   does not sign in.
4. **The credential is changed only where it lives.** A password reset on the
   linked account is refused (`auth.credentialManagedElsewhere`); the owner
   resets on the platform site.
5. **One link, one level.** An account may not link to an account in its own
   tenant, nor to an account that is itself linked.
6. **Creating it is identity's, on request.** `tenant-service` never writes
   `identity.user` (ADR-0058 (4)); it asks auth-service's internal
   `POST /api/internal/owner-accounts` (service token, the reseller's tenant in
   scope). The call is idempotent per `(tenant, credentialUserId)`, and refused
   when the phone is already another account of that tenant.
7. **Entering from the platform site** is a one-time code minted on the
   platform host and redeemed on the reseller's host for a session of the
   linked account (F-061-d).

## Alternatives

| Option | Why not |
|---|---|
| A membership row (`tenant_staff_member`) admits a platform user on the reseller's host | a session would have to carry a home tenant apart from the acting one: ADR-0024 (4) rewritten, a new claim in the gateway, and the ~30 scoped `user` reads in auth-service re-pointed. Proposed first, withdrawn on that evidence (user, 2026-09-18) |
| A second password on the reseller's account | two credentials for one person, drifting apart; a reset on one leaves the other |
| Reset on the linked account changes the platform password | the linked account's phone is a copy; once the owner changes theirs, whoever holds the old number could take the platform account |

## Consequences

- A person who owns two resellers has two linked accounts; staff of a reseller
  (F-018-j) are that tenant's own accounts, linked or not.
- The linked account's phone can fall behind the platform account's. Keeping
  it current is open (`identity/open-questions.md`).
- `CrossTenantPrismaService` gains one reader: `CredentialHolder`.
