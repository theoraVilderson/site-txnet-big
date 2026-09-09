---
id: adr-0023
status: accepted
updated: 2026-09-09
---

# ADR 0023 — A phone number is unique within a tenant, not across the platform

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** identity, tenant, auth-api, bot-app, redis-keyspace

## Context

`user.username` and `user.phoneNumber` are `@unique` columns —
platform-wide, across every tenant (`prisma/domains/identity.prisma`). The
constraint predates tenancy being load-bearing: until ADR-0020 every account
belonged to `platform_owner`, so "unique globally" and "unique per tenant" were
the same statement and nothing chose between them.

They stopped being the same statement the moment a request could resolve to a
different tenant (ADR-0020, F-061-a/F-061-b). Today, if two resellers each sell
to the same person — a perfectly ordinary thing on a white-label platform —
the second registration is refused with `register.duplicateUser`, and the
reseller has no way to see why, because the colliding account is in a tenant
they cannot read. The platform silently makes its resellers share a customer
namespace, which is the opposite of what white-label means.

It is not only a uniqueness constraint. Identity is looked up by phone number in
roughly ten places (login, forgot-password, OTP senders, bot-link, bot-session)
and keyed by phone number in six Redis key builders (`otp:code:*`,
`otp:cooldown:*`, `register:pending:*`, `botlink:*`). Every one of those is a
global namespace today. A per-tenant `user` constraint with global OTP keys
would be worse than either consistent choice: two tenants' codes for the same
number would evict each other, which invariant #10 (one active code per
(phone, purpose)) would enforce *across a tenancy boundary*.

## Decision

**A person is identified within a tenant.** `user.username` and
`user.phoneNumber` lose their column-level `@unique` and gain
`@@unique([tenantId, username])` and `@@unique([tenantId, phoneNumber])`. Every
lookup by phone or username is scoped by the request's resolved tenant, and
every Redis key derived from a phone number gains a tenant segment.

The same person registering with two resellers becomes two `user` rows, in two
tenants, with two wallets and two histories. They are not linked, and the
platform does not tell either reseller that the other exists.

## Consequences

- Positive: a reseller's customer list is genuinely theirs. This is the
  constraint white-label actually requires, and every other tenant-scoped rule
  already assumes it (`audit`'s switch group filters members by `tenantId`,
  C-22).
- Positive: it removes a cross-tenant information leak. `register.duplicateUser`
  today answers a question about a *different* tenant's data.
- Negative / accepted cost: a `REDIS_KEYSPACE_VERSION` bump, which abandons
  every in-flight OTP, pending registration and bot-link token and logs everyone
  out — the same cost ADR-0018 paid and for the same reason.
- Negative / accepted cost: `linked_bot_account` is `@@unique([platform,
  platformUserId])`, so one Telegram account still belongs to at most one User
  platform-wide (invariant #12). One person cannot hold two tenants' accounts in
  one chat. That is a real limit and it is **not** resolved here: relaxing it
  touches the security proof invariant #12 exists for, which deserves its own
  decision.
- Forecloses: a platform-wide "sign in once, see every reseller you buy from"
  identity. If that is ever wanted it is a new concept — a person who owns
  several accounts — not a loosened constraint.

## What this decision does not answer, and why it is not yet implementable

**A surface that is not an HTTP request has no tenant.** ADR-0020 resolves the
tenant from the Host header. `bot-service` calls `auth-api` over an internal
address (`AUTH_API_BASE_URL=http://auth-service:<port>`,
`dev-docker/docker-compose.main.yml`), so a bot-originated registration arrives
with the container's own name as its host, matches no `tenant_domain` row, and
falls back to `DEFAULT_TENANT_SLUG` — every messenger user on a multi-tenant
deployment lands in one tenant regardless of which reseller's bot they spoke to.

The mapping that would fix it — this bot token belongs to that tenant — is
`tenant_bot_integration`, a table with no service behind it (`tenant` is
implemented for host resolution only; the rest is F-018).

So this ADR is the decision, not the plan. Scoping identity by tenant while one
whole surface cannot name its tenant would move the bug rather than fix it: bot
registrations would collide inside the default tenant while panel registrations
were correctly separated. The work is split accordingly — see F-065-a / F-065-b
/ F-065-c in `BACKLOG.md`, the first of which is teaching a bot request to carry
its tenant.
