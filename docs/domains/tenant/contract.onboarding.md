---
id: tenant
layer: domain
status: active
version: 4
updated: 2026-09-19
---

# Contract — tenant / the onboarding gate

A topic file of `contract.md` (§10). A reseller that has not proved a domain of
its own reaches a configuration console and nothing else (F-018-l, catalog
F-213). Code: `shared-core/src/lib/tenant/status-policy.ts` (the column),
`tenant-service/src/app/status/tenant-status.listener.ts` (it is computed),
`tenant-service/src/app/onboarding/` (the checklist).

## The gate

**A column, not a status.** `TenantOnboardingPolicy` is applied on top of the
tenant's own column of `TenantStatusPolicy`, and `tenantAllows` takes the
stricter of the two answers — a reseller is `trial` or `active` *and*
onboarding. It closes exactly what needs a door of the reseller's own:

| Capability | onboarding |
|---|---|
| `signIn`, `signOut`, `read`, `account`, `staffWrite`, `tenantBilling`, `system` | yes |
| `register`, `sell`, `endUserDeposit`, `subscriptionLink` | **no** |

So the owner and the reseller's staff sign in on the platform's domain,
configure everything (`staffWrite`) and top the billing wallet up; nobody
registers, buys, deposits, or is served a `/sub` link. The refusal is `403`
`{i18nKey: tenant.onboarding, reason: tenantOnboarding}` — the first refusal a
`trial` or `active` tenant can get, and the reason a consumer tells it apart
from a suspension by. The platform owner is never gated.

**What it deliberately does not close.** `signIn`, `read` and `account` stay
open, because the reseller's owner and staff sign in to that tenant to
configure it — closing them by capability would lock a reseller out of the one
screen that lifts the gate. What D-01 still wants closed on a platform host is
therefore a question of *what a host serves*, not of what a status allows, and
it is answered below.

**It is left by proving a domain, never by paying.** One `verified`,
`panel`, `custom_domain` row lifts it (`contract.domains.md`); a
`revalidating` one still routes, so it still lifts it.

## Where the answer lives

`tenant:status:<tenantId>` gains an `onboarding` boolean beside `status` and
`graceEndsAt`. `TenantStatusListener` computes it from the tenant's rows on
every notification and on each connect, so **nothing stores it**: there is no
`onboardingCompleted` column to go stale, and a reseller whose last domain
drops to `pending` is gated again without anything remembering to.

The listener wakes on a domain change as well as a status one — migration
`20260919000400_tenant_onboarding_gate` puts a `tenant_status_changed` NOTIFY
on `tenant_domain` (`verificationStatus`, `purpose`, `domainType`, and
insert/delete). Without it the sweep could verify a domain and leave the gate
shut in Redis until the next connect.

A state with no `onboarding` key is **not** onboarding: a key written before
this row, or a reader that never learned about it, behaves exactly as before.

## The door a gated reseller is served on

**While the gate is on, the reseller's platform `subdomain` serves nothing, to
anyone** — not its end users (F-018-ag, D-01: no platform domain or subdomain
is ever served to an end user) and not the reseller itself (F-066-x, user
2026-09-19). The reseller configures from the platform's own panel, where its
owner's account already lives (ADR-0059), until a domain of its own is proved;
if that domain later drops back to `pending`, the subdomain closes again with
it. Code: `auth-service/src/app/tenant/door.ts` (`gatedDoor`), enforced by
`TenantGuard` as the fourth of its refusals.

It is the seam F-066-q built, with the gate as a third input beside the
surface's `purpose`. Resolution answers `surfaceDomainType` as well, so the
rule can say *platform host* at all:

| the surface | while the tenant is onboarding |
|---|---|
| `panel` + `subdomain` — a platform-issued host | **nothing** — every path is the neutral 404 |
| a reseller's CNAME target `<slug>.edge.<domain>` | **nothing, gated or not** (ADR-0063) |
| `panel` + `custom_domain` — the reseller's own, proved | everything, unfiltered |
| `subscription` / `assets` | unchanged: that purpose's (empty) allowlist |
| no surface at all — an internal caller on a container name | everything |

**A reseller's only platform host is now its CNAME target** (ADR-0063, F-018-ai):
no `<slug>.<domain>` is created, and the target serves nothing even once the
gate lifts — `surfaceIsTarget` on the resolved tenant, from the host's
spelling, never cached. `gatedDoor` still holds for any other reseller
subdomain; none is written any more.

**Why the console left the subdomain too** (user, 2026-09-19). F-018-ag kept
it open for the reseller's own staff. A platform host a reseller can use is a
platform host it can hand its customers, and a filter on the platform's name
then takes every reseller's users down together. Its cost: a reseller's staff
whose accounts live in the reseller's tenant have no door until the domain is
proved — only the owner, signed in on the platform's panel, configures.

**The gate that is read belongs to the tenant that owns the host**, which is
`brand` when the surface's tenant is not the scoped one (ADR-0059's
reseller-owner case) and the resolved tenant otherwise. Reading the scoped
tenant instead would open the door for exactly the account most likely to be
standing at it. The Redis read is `tenant:status:<surface tenant>` and is paid
only on a `panel` `subdomain`; a missing or unparseable state closes nothing,
the same trade `TenantStatusGuard` makes.

**The platform's own main domain is never filtered** (user, 2026-09-19). It
belongs to the platform owner, and the platform owner is never onboarding — so
a reseller parking its end users on the platform's domain cannot cause the
platform's own host to serve less.

The refusal is the **neutral 404**, not the gate's 403: on the platform's own
domain a stranger must not learn that a particular reseller lives at this
address (F-1210).

### The panel asks before it renders (F-066-x)

`site-pwa` is a separate deployable that every host reaches (F-066-u), so the
same rule has to hold for the page. It is not restated there:
`GET /api/auth/door` answers `{ serves: boolean }` for the host that asked,
from the same resolution and the same `gatedDoor` read (`door.controller.ts`).
`false` on a reseller's CNAME target, a gated reseller's platform subdomain
and a `subscription` / `assets` domain; `true` otherwise.

- It is the one route `TenantGuard` exempts from refusals (3) and (4)
  (`@DoorProbe`) — it must answer on exactly the doors they close. An
  unregistered host is still the neutral 404, which the panel reads as "render"
  (F-066-u's own call).
- `@TenantCapability('system')`: no status refuses the question.
- The answer carries no purpose, gate or tenant — a stranger learns no more
  from it than from the page the panel then does or does not render.

The panel's side — the cache, and why every doubt renders — is
`panel-web/contract.origin.md` "A host that serves no panel".

## The checklist

`GET /api/tenants/:id/onboarding`, `ResellerAccess` (invariant 21) as a
`read` — so a suspended reseller still sees what it would have to do.

```
{ tenantId, onboarding, closed: [...capabilities], complete,
  steps: [{ key: 'domain' | 'gateway' | 'bot' | 'pricing', done, gate }] }
```

**Every step is computed from live rows, never stored** — a `verified` panel
domain, an `isActive` + `verified` `tenant_gateway_config`, an `active`
`bot_integration`, an `isActive` `price` on an `isActive` variant. A reseller
that deletes its last gateway is back on that step.

**Only `domain` is the gate** (`gate: true`); the other three are what the
console asks for next and refuse nothing, because a reseller may sell without a
bot and price its products the day after it opens. `complete` is all four;
`onboarding` is the gate alone, and the two differ on purpose.

Refusals are `ResellerAccess`'s: `not_allowed` 403, `reseller_not_found` 404,
`reseller_suspended` 403, `reseller_terminated` 409.

## Consumers

| Consumer | Uses |
|---|---|
| auth-, billing-, notification-service | `TenantStatusGuard` — inherit the column through `tenantAllows`, unchanged |
| worker-service `TenantStatusGate`, gateway-service `TenantSocketWatch` | the same state; a gated tenant's ticks and sockets follow their capability |
| panel-web | the console itself — not built yet (F-066-*); the door rule above has no `panel-web` mirror yet either |
