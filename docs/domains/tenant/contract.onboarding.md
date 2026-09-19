---
id: tenant
layer: domain
status: active
version: 5
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

**A reseller's platform `subdomain` serves nothing, to anyone, gated or not**
(ADR-0063; F-018-ag and F-066-x before it; D-01: no platform domain or
subdomain is ever served to an end user). A reseller's only one is its CNAME
target `<slug>.edge.<domain>`, which connects its own domain and is never a
door; a `<slug>.<domain>` row from before ADR-0063 is closed the same way. The
reseller configures from the platform's own panel, where its owner's account
already lives (ADR-0059); its customers reach it only on a domain of its own.
Code: `auth-service/src/app/tenant/door.ts` (`doorClosed`), enforced by
`TenantGuard` as the fourth of its refusals.

It is the seam F-066-q built, with **who owns the host** as the third input
beside the surface's `purpose`. Resolution answers `surfaceDomainType` and
`surfaceTenantType`, so the rule can say *a reseller's platform host* at all:

| the surface | serves |
|---|---|
| `panel` + `subdomain` of a **reseller** — its CNAME target, or an old row | **nothing** — every path is the neutral 404 |
| `panel` + `subdomain` of the **platform owner** — `panel.<domain>`, `api.<domain>` | everything, unfiltered |
| `panel` + `custom_domain` — the reseller's own, proved | everything, unfiltered |
| `subscription` / `assets` | unchanged: that purpose's (empty) allowlist |
| no surface at all — an internal caller on a container name | everything |

**The gate is not read.** Whether the reseller is onboarding no longer
matters to the door: it has no platform subdomain that could open. So the rule
is a fact about the host, costs no Redis read, and cannot be opened by a state
that is missing.

**The owner that is judged is the host's**, `brand` when the request is scoped
to the reseller owner's own tenant (ADR-0059) — `surfaceTenantType` is always
the surface's. Judging the scoped tenant would open the door for exactly the
account most likely to be standing at it.

**No stale cache entry can reopen a deleted row.** `tenantType` is part of
the cached surface and required by the cache's shape check, so every entry
written before it re-read at the deploy that added it — including those for
the rows ADR-0063's migration deleted in SQL, where Redis cannot be reached.
And an entry written since says `reseller`, which this rule closes anyway.

**Why the console left the subdomain too** (user, 2026-09-19). F-018-ag kept
it open for the reseller's own staff. A platform host a reseller can use is a
platform host it can hand its customers, and a filter on the platform's name
then takes every reseller's users down together. Its cost: a reseller's staff
whose accounts live in the reseller's tenant have no door until the domain is
proved — only the owner, signed in on the platform's panel, configures.

**The platform's own main domain is never filtered** (user, 2026-09-19): it is
the platform owner's, not a reseller's.

The refusal is the **neutral 404**, not the gate's 403: on the platform's own
domain a stranger must not learn that a particular reseller lives at this
address (F-1210).

### The panel asks before it renders (F-066-x)

`site-pwa` is a separate deployable that every host reaches (F-066-u), so the
same rule has to hold for the page. It is not restated there:
`GET /api/auth/door` answers `{ serves: boolean }` for the host that asked,
from the same resolution and the same `doorClosed` rule (`door.controller.ts`).
`false` on a reseller's platform subdomain and a `subscription` / `assets`
domain; `true` otherwise.

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
`bot_integration`, and something the catalog offers the reseller. A reseller
that deletes its last gateway is back on that step.

**`pricing` means "there is something to sell"** (F-018-ah): one variant
`listOffers` would return to the reseller now — `public`, product and category
active, a price in effect — **its own or the platform's** (`tenantId IS NULL`,
which every tenant inherits). A reseller selling only the platform's catalog
has done it. The predicate is the catalog's, `offeredToTenant` in
`shared-core/src/lib/catalog/offers.ts`, which `CatalogReadService` asks too;
tenant-service holds no copy of the visibility rules.

**Only `domain` is the gate** (`gate: true`); the other three are what the
console asks for next and refuse nothing, because a reseller may sell without a
bot and price its products the day after it opens. `complete` is all four;
`onboarding` is the gate alone, and the two differ on purpose.

Refusals are `ResellerAccess`'s: `not_allowed` 403, `reseller_not_found` 404,
`reseller_suspended` 403, `reseller_terminated` 409.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| catalog | `offeredToTenant` (shared-core): the `pricing` step, own or platform offers (F-018-ah) | the step reads `done: false`; nothing is gated on it |

## Consumers

| Consumer | Uses |
|---|---|
| auth-, billing-, notification-service | `TenantStatusGuard` — inherit the column through `tenantAllows`, unchanged |
| worker-service `TenantStatusGate`, gateway-service `TenantSocketWatch` | the same state; a gated tenant's ticks and sockets follow their capability |
| panel-web | the checklist, on `/my-resellers/:id` (F-066-w, `resellerOnboardingApi`); the door rule through `GET /api/auth/door` (F-066-x) |
