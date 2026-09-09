---
id: identity
layer: domain
status: active
version: 10
updated: 2026-09-09
---

# identity — version history

What each version of [contract.md](contract.md) changed, which consumers it
affected, and why. Split out of `contract.md` at 250 lines (§10) — the current
shapes live there, and this file answers "when did that change, and what broke".

Newest first is *not* the order here: the sections are kept as they were
written, and `version` in the front matter above says where the contract is now.
The current version's own section stays in `contract.md` until the next one
displaces it.

## v9 — a person is identified within a tenant

**Breaking, in meaning rather than in shape.** `user.username` and
`user.phoneNumber` were unique across the whole platform; they are now unique
within a tenant (`@@unique([tenantId, username])`,
`@@unique([tenantId, phoneNumber])`, migration
`20260909000300_identity_unique_per_tenant`). ADR-0023 is why.

What changes for a caller is what an answer *means*, not what it looks like:

- `register` refuses `register.duplicateUser` about the caller's own tenant
  only. The same phone number registering with two resellers is now two
  accounts, and neither reseller is told the other exists.
- `login`, `request OTP`, `forgot password` and the OTP senders resolve an
  identifier within the requesting tenant. A phone number that names an
  account in another tenant is simply not found, and answers exactly what an
  unknown number answers — the enumeration-safety rule above is unchanged and
  now holds across tenants too.

No operation gained or lost a parameter. Nothing here is a scoping decision
identity makes: the tenant is ambient (v8), so the ~13 lookup sites were not
edited — `withTenant` scopes them (ADR-0024). Eight `findUnique` calls became
`findFirst`, which is a Prisma typing consequence of a column no longer being
unique on its own, not a semantic one: the composite index still guarantees at
most one row per tenant.

**Affected consumers** (every unit listing `identity` in `depends_on`): audit,
billing, currency, engagement, fraud, governance, network, notification, ai,
support, tenant, auth-api, forward-auth. None of them queries identity's tables
(`data-model.md`, access rules) and none passes an identifier for another
tenant, so no consumer call site changes. Nothing is deprecated, because no
shape is removed.

**Still open:** the OTP, pending-registration and bot-link Redis keys are built
from a bare phone number, so they remain one namespace across tenants. That is
F-065-c, and until it lands invariant #10 is enforced across a tenancy
boundary. `linked_bot_account` also stays `@@unique([platform, platformUserId])`
— invariant #12 — which is F-066-l.

## v8 — the tenant is ambient, not an argument

**Breaking, in meaning rather than in shape**, and only for an in-process
caller. v7's fourth parameter is gone: `register` reads the tenant from the
scope the edge opened (ADR-0024, `platform/tenant-context/contract.md`) instead
of being handed it. The refusal is unchanged — no resolved tenant is still
`register.tenantUnresolved`, never a fallback — and the wire is untouched.

Identity's position is also unchanged: it neither resolves the tenant nor reads
`tenant_domain` (§8). It reads a value `tenant` decided, through a `platform`
unit that only carries it, so identity gains no `depends_on` edge to `tenant`.

**Affected consumers** (every unit listing `identity` in `depends_on`): audit,
billing, currency, engagement, fraud, governance, network, notification, ai,
support, tenant, auth-api, forward-auth. Exactly one call site exists —
`auth-api`'s `RegisterController` — and it is updated in the same change. The
v7 shape is removed rather than deprecated for a release (§8.3) because it is
in-process and one commit old: `tenant-context`'s own Deprecations table named
F-066-a as its removal point on the day it was written, and no consumer outside
this process could ever have called it.

**Known limit at the time, since closed by v9:** username and phone number
were still unique platform-wide.

## v7 — a registration lands in the tenant the caller resolved

**Breaking, in meaning rather than in shape.** `register` used to find its own
tenant, by looking up `Tenant.slug = 'platform_owner'`. It now takes the
resolved tenant from its caller and refuses (`register.tenantUnresolved`) when
there is none. Nothing about the wire changed — the host that decides the
answer was always on the request — so a client sees a difference only on a
deployment that serves more than one tenant, which is the point of the change.

Identity does **not** resolve the tenant and does not read `tenant_domain`:
that table is `tenant`'s (§8), and the resolution rule is `tenant`'s
(ADR-0020, `domains/tenant/contract.md`). `auth-api` reads what
`TenantMiddleware` already attached and passes it in, which is why this adds no
`depends_on` edge from identity — the edge is `auth-api -> tenant`, and it
already exists.

**Affected consumers** (every unit listing `identity` in `depends_on`): audit,
billing, currency, engagement, fraud, governance, network, notification, ai,
support, tenant, auth-api, forward-auth. Only `auth-api` calls `register`, and
it is updated in the same change. No shape is deprecated, because none is
removed.

**Known limit at the time, since closed by v9:** two tenants could not both
register the same phone number.

## v6 — sessions carry the scope they were minted on

Additive. `Session.scopeKey` (nullable) records the **switch scope** a session
was created on — the same key shape `audit.linked_account_member` uses
(ADR-0015) — and one new operation, **revoke a user's sessions in one scope**,
reads it. Existing operations keep their meaning; the two that gain an optional
trailing argument (`hand over a session`, and the session-minting paths behind
login / register-verify / reset) default to no scope, which is a legitimate
state meaning "belongs to no switch group".

Why identity carries a key whose meaning lives in `audit`: F-0208 has to revoke
the removed account's sessions on **one surface only**, and a session is
identity's. `audit` decides *which* scope; identity records and honours it.
Null is deliberate for impersonation — an admin's session belongs to no group,
so it matches no scope and is never caught by a removal.

## v5 — a session handover, for account switching

Additive. One new operation, **hand over a session**, used by `audit` alone
(`AccountSwitchService.switchTo`, F-0207) and surfaced as
`POST /auth/accounts/switch`. It takes nothing away: every existing operation
keeps its meaning, and no caller that ignores it sees a change. Adds
`SessionRevokedReason.account_switched` to the schema — a Prisma migration, not
a flag.

The reason it lives here rather than in `audit`: sessions are identity's, and a
switch is two session writes that must not come apart. `audit` owning the
membership rule and identity owning the handover is the same split F-0205 made
for the proofs.

## Breaking: v3 — reset password returns a session

`reset password` used to answer `{success:true}` and leave the caller signed
out everywhere, including on the device in front of them. It now also returns
`{accessToken, expiresIn}` and sets the `refresh_token` cookie.
**Affected consumer:** `panel-web` — updated in the same change
(`lib/auth-api.ts` stores the token; the forgot-password screen goes to the
panel instead of the login form). A client that ignores the extra fields keeps
working; one that assumed "reset always means signed out" does not.
