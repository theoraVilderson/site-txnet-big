---
id: tenant
layer: domain
status: active
version: 1
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
| panel-web | the console itself — not built yet (F-066-*) |
