---
id: adr-0059
status: accepted
updated: 2026-09-18
---

# ADR 0059 — A tenant's owner signs in on its domain with their own account

- **Status:** accepted 2026-09-18 with F-061-c (user); (6) added with F-061-i, (7) with F-061-f (user, 2026-09-18)
- **Date:** 2026-09-18
- **Affects units:** identity, tenant, auth-api, audit, forward-auth
- **Amends:** ADR-0024 decision 4; ADR-0015's bot key (by (5), F-061-g)

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
4. **OTP sign-in, 2FA and password reset follow (3)** (F-061-d, F-061-e): the
   code is requested, issued, checked and the session opened in the owner's
   tenant, and the request's 202 does not change with a match. A reset changes
   the owner's one password and revokes their sessions everywhere. **Not in this decision:** the
   owner's administration routes (`tenant-service`, F-018-y).
5. **Account switching and the Mini App follow the door** (F-061-g, user
   2026-09-18). A switch group on the owner's domain holds only accounts that
   domain admits — its tenant's own and the owner — so the owner switches
   between their account and their reseller's accounts there, never to their
   other platform accounts (which (1) would refuse). Proofs run in the door's
   tenant and fall back to the owner as in (3). The Mini App verifies with the
   door's bot and signs the owner in through their own contact-verified
   messenger link. A chat's switch scope names its bot's tenant,
   `bot:<tenantId>:<platform>:<chatId>`: a private chat id is the person's id
   with every bot, so the platform chat's group and acting-as pointer would
   otherwise follow the owner into their reseller's Mini App.
6. **A reseller's bot is a door like its domain** (F-061-i, user 2026-09-18).
   The chat session (`/auth/bots/session`) admits the bot tenant's owner as (1)
   does: when the bot's tenant holds no account for the chat, the owner's own
   contact-verified link — or their contact card, looked up by number after
   the tenant's own accounts — signs them in, in their own tenant. The link is
   written there: one `linked_bot_account` per person per messenger, so linking
   in the reseller's bot links the platform's too. On later calls the resolver
   treats the bot claim as it treats a host: a session that disagrees with it
   is `403 tenant.claimMismatch` unless it is that tenant's owner's, scoped to
   their own tenant with `brand` = the bot's. It used to prefer the session
   silently, which is ADR-0024 (4)'s leak through a different door.
7. **The platform panel hands the owner across** (F-061-f, user 2026-09-18:
   "exactly as on the platform, no limitation"). The refresh cookie is
   host-only (ADR-0060 (4)), so a session cannot follow the owner to their
   domain. The platform mints a 60s single-use code naming the account and the
   reseller; only that reseller's panel domain spends it, for the session (3)
   would open there. Not a signed token in the URL: a code can be spent once
   and dies with the Redis key, and the fragment keeps it out of every log.

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
