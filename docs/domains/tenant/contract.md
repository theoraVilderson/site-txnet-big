---
id: tenant
layer: domain
status: active
version: 24
updated: 2026-09-28
---

# Contract — tenant

**Resolution, the vault, the billing wallet and reseller creation are implemented; the rest are intended.** *Resolve tenant
by claim* is real code (`app/tenant/`, F-061-a, F-066-c, F-066-d). Every other row in *Provides* is still a shape derived
from `txnet-backend/prisma/domains/tenant.prisma`, with no service behind it — the `(intended)` marker on that table is
what tells them apart, and it is the thing to check before calling one.

## TL;DR

A Tenant is an isolation + branding boundary. Exactly one is `platform_owner`;
the rest are `reseller`. The platform bills tenants from a prepaid wallet
(D-41: subscription, no metering); tenants collect from their own end users through their own gateway
(ADR-0006). A central entitlement check gates every feature per tenant.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| **resolve tenant by claim** — implemented | `{host?, session?, bot?}` | `{id, slug, via, surfacePurpose?, surfaceDomainType?}` or `null` — `null` means *no tenant*, never a fallback | sync | `TenantClaimConflict` when a claim and its surface disagree |
| **create / list / read a reseller** — implemented, [contract.admin.md](contract.admin.md) | slug, billingModel, owner | reseller view | sync tx | `not_platform_owner` / `slug_taken` / `reseller_not_found` |
| **a platform user buys a reseller** (F-019-h) — implemented, [contract.admin.md](contract.admin.md) | packageId, billingModel, name, slug? | reseller view, `active`, first period charged from the buyer's wallet | sync tx | `already_reseller` / `insufficient_balance` / `slug_taken` |
| **create / edit / deactivate a package; force its keys onto subscribers** — implemented, [contract.admin.md](contract.admin.md) | name, monthly/yearly price, includedFeatureKeys, isActive | package view (an added key granted to subscribers in the edit) | sync tx | `not_platform_owner` / `package_not_found` / `package_name_taken` / `package_price_in_use` / `package_unpriced` |
| **put a reseller on a package and period** — implemented, [contract.admin.md](contract.admin.md) | tenantId, packageId, billingModel | subscription view; `package_included` entitlements replaced | sync tx | `reseller_not_found` / `reseller_terminated` / `package_not_found` / `package_inactive` / `package_not_sold_for_period` |
| **suspend / reactivate / terminate a reseller; what each status allows** — implemented, [contract.admin.md](contract.admin.md), [rules.md](rules.md) | tenantId, status, reason | status view; Redis `tenant:status:<id>` rewritten; `TenantStatusGuard` (shared-core) refuses per capability | sync tx | `reseller_not_found` / `reseller_terminated` / `status_unchanged`; `403 tenant.suspended` / `tenant.terminated` |
| **check entitlement; gate a route on a feature; admit a caller to a route naming a reseller (invariant 21), or answer them whether it would (`GET /api/tenants/:id/access`, F-311-e)** — implemented, [contract.entitlements.md](contract.entitlements.md) | tenantId, featureKey | allowed (+ source, expiry) / denied; `@RequiresFeature(key)`; `{canRead, canWrite, reason}` | sync | `403 tenant.featureNotEntitled`; the access read refuses nobody |
| **add and prove a custom domain** — implemented, [contract.domains.md](contract.domains.md) | tenantId, domainValue, purpose | domain view with TXT record, CNAME target, last check | sync add; async check (worker sweep) | `not_allowed` / `domain_taken` / `domain_reserved` |
| **edit a reseller's branding; read it by Host** — implemented, [contract.branding.md](contract.branding.md) | tenantId, text, one image per slot | branding view with image URLs on the tenant's own door | sync | `not_allowed` / `reseller_suspended` / `too_large` / `type_not_allowed` |
| **read / set a tenant's operating currency** (F-116-a, ADR-0098); a set converts its live money (F-116-f) — implemented, [contract.currency.md](contract.currency.md) | tenantId, code | `{code, choices}`; a set adds `conversion` | sync | `not_allowed` / `reseller_suspended` / `currency_unavailable` / `currency_changed` / `rate_unavailable` |
| **credit / debit the billing wallet** — implemented, [contract.billing.md](contract.billing.md) | tenantId, reason, amount, reference | `tenant_billing_transaction` (append-only); a credit also writes `tenant.billing.credited` | sync tx | insufficient / duplicate / version conflict |
| **renew a reseller's subscription** — implemented, [contract.billing.md](contract.billing.md), [rules.md](rules.md) #10-#13 | tenantId, or every due one | charged + period moved on, or warned, or suspended as `non_payment`; outbox notices | async (worker sweep + `tenant.billing.credited`) | a failing tenant is `failed` in the sweep |
| meter usage | tenantId, meterKey, quantity, period | `tenant_usage_meter` row | async (worker) | — |
| set BYO gateway/SMS/bot config | tenantId, encrypted credentials | config row, `pending` verification | sync | — |
| **store / use a tenant credential** — implemented | see [contract.vault.md](contract.vault.md) | | | |

## Resolve tenant by claim (implemented — ADR-0020, ADR-0024, ADR-0025)

`TenantResolverService.resolve(claim)`. The claim is assembled once, by
`TenantMiddleware`, and **that middleware is the only code that reads a header
for tenancy** (catalog F-1209: one reader, one decision, one context object).
The answer is attached to the request, and `TenantContextMiddleware` turns it
into the ambient scope every query is enforced against (ADR-0024,
`platform/tenant-context`).

A claim has three parts, and each is trusted for a different reason:

| part | source | trusted because |
|---|---|---|
| `session` | `tenantId` of an access token whose signature verified | forging one needs the signing secret. An invalid, expired or purpose-bound token simply carries no claim — the middleware never answers 401, `AuthGuard` still owns that |
| `bot` | `X-Tenant-Id`, **only** from a caller whose `x-service-token` verified | the header alone is forgeable; the service token is not (ADR-0011) |
| `host` | `req.hostname` — Express strips the port and, with `trust proxy`, reads `X-Forwarded-Host`, which is what Traefik forwards | the platform issued the mapping. Normalized by `normalizeHost` before lookup |

The chain, in order:

1. **The surface.** A `tenant_domain` row whose `domainValue` equals the
   normalized host — a `subdomain` as it stands, because the platform issued it;
   a `custom_domain` **only** when `verificationStatus` is `verified`, because
   the reseller claimed it and ownership has to be proven (invariant 5). An
   unverified custom domain is treated as an unknown host, not as an error.
2. **A claim outranks the surface**, and `via` says which answered — `session`,
   `bot`, or `domain` when there was no claim. A claim is still proven against a
   real `tenant` row, so a token outliving its tenant resolves to `null` rather
   than to an id nobody owns. A session and a bot claim that disagree are never
   resolved by preferring the session: the bot is a door (ADR-0059 (6), F-061-i).
3. **A claim and a surface that disagree are refused**, not reconciled:
   `TenantClaimConflict` (ADR-0024 decision 4). This closes the leak ADR-0024
   records — a tenant-A session presented on tenant-B's host used to resolve to
   whichever of the two the reader happened to consult. Picking either side
   serves one tenant's data under the other's brand, so neither is served.
4. **Neither → `null`. There is no fourth entry** (ADR-0025, F-1210). A host no
   `tenant_domain` row matches, on a request carrying no claim, has no tenant —
   and `null` is the answer, not a degraded one.

**Both refusals are raised by a guard, not by the middleware.** A global
exception filter does not catch what Express middleware throws, so the
middleware records what it decided on the request and `TenantGuard` — global,
registered by `TenantModule` — answers in the same envelope every other error
uses. It checks the conflict first, because a refused claim also leaves no
tenant on the request and the order is what keeps the two cases apart:

| the request | answer | what the client can tell |
|---|---|---|
| claim disagrees with surface, or a session with the bot it came through | `403 tenant.claimMismatch` — **except** the surface's (or bot's) tenant's owner on a `panel` surface or through its bot, with their own session (ADR-0059 (1), (6)): scoped to the session's tenant, `brand` = the surface or bot | that this session does not belong here — never which tenant does |
| resolved to no tenant | **neutral `404`** | nothing. `system.notFound`, byte-identical to an unmatched route |

The 404 is neutral by construction rather than by wording: the guard throws a
bare `NotFoundException`, whose message is not an i18n key, so `sanitizeError`
replaces it with the generic `system.notFound` any missing path produces. A
stranger cannot tell a host the platform does not serve from a path that does
not exist, which is what *"must not reveal that a platform exists"* asks for
(F-1210). The host is named in the server log and nowhere else.

**There is no fallback tenant, in any environment** (ADR-0025, superseding
ADR-0020). `DEFAULT_TENANT_SLUG` is gone from the code, the schema of the
environment, and the compose stack. The cost is real and accepted: a fresh
install answers nothing until a `tenant_domain` row exists, so `prisma/seed.js`
creates the platform owner's row for `api.$DOMAIN_NAME`, and the e2e harness
seeds its own for `127.0.0.1` (`auth-service-e2e/src/support/app.ts`) — which
also means the suite now exercises resolution rather than proving a fallback.

**Every lookup — host and claimed id — is cached in Redis, and retracted
explicitly rather than left to expire** (ADR-0025 decision 4, F-1211). The
cache is `TenantCacheService`, exported by `TenantModule` beside the resolver,
and the rule it imposes on the rest of the platform is one sentence:

> **Any write that changes which tenant a host belongs to must call
> `invalidateDomain(domainValue)` in the same operation** — creating a
> `tenant_domain` row, verifying one, switching a standby over, deleting one.
> A write that changes whether a tenant exists at all calls
> `invalidateTenant(tenantId)`.

The cache is shared rather than in-process precisely so that rule can be
obeyed: the process that verifies a domain is not the process serving the next
request on it, and a per-replica `Map` cannot be told anything. For the window
in between, a request arriving on a host that now belongs to someone else is
served as its previous owner — a cross-tenant leak, not a stale page, which is
why the catalog names the invalidation and not a shorter TTL.

The TTLs that remain are **backstops** on a writer that forgets, not the
mechanism: `RedisTtl.tenantResolution` (600s) for a resolved answer,
`RedisTtl.tenantResolutionMiss` (60s) for a cached *no tenant* — shorter
because a miss is what a stranger's host writes, and its lifetime is what
bounds how many keys a flood of invented hostnames holds at once. A cached
miss is a real answer and is what keeps an unknown host off Postgres.

Reads fail open and invalidation fails loud. A Redis outage makes the resolver
slow, not wrong — a read that throws is logged and treated as a miss, because
the database still knows the answer and the alternative is a neutral 404 on
every request. An `invalidate*` that cannot reach Redis **throws**, so the
caller refuses the domain change rather than completing it on top of a mapping
it failed to retract.

**The first caller is reseller creation** (F-018-c, `contract.admin.md`), which
retracts the new subdomain inside its transaction — from `tenant-service` since
F-018-y, by deleting `tenant:host:<host>` directly. `prisma/seed.js` and the e2e
harness still write rows directly. F-018-i's domain proof is the second (`contract.domains.md`); F-102 and F-113 inherit it.

**A request from another service has no host worth resolving, so it names its
tenant instead.** `bot-service` calls this API at `http://auth-service:3001` —
a container name no `tenant_domain` row names, and a bot chat has no host of
its own — so it sends `BOT_TENANT_ID` as `X-Tenant-Id` alongside its service
token, and the `bot` row of the claim table above answers. That is the seam
F-066-c built, used for the case it was built for; F-066-i replaces the env
var with a per-`BotIntegration` lookup and the header stays where it is.

Seeding the internal host as a `tenant_domain` row would have looked like the
same fix and is not one: it would give those calls a *surface*, and once
F-066-i has the bot claiming a real tenant, a claim that disagrees with that
surface is a `403` rather than a resolution.

**A caller that names no tenant is refused, deliberately.** An install with
`BOT_TENANT_ID` unset sends no header, resolves to nothing, and gets the
neutral 404 — the same answer a stranger's host gets. There is no
service-caller exemption: a verified service token says *who* is calling, never
*for whom*.

**The host is the panel's own.** Since ADR-0060 the panel calls `/api/*` on the
domain it was loaded from, and Traefik routes it on every host, so the host a
call resolves from is the reseller's panel domain (or `panel.<domain>`, seeded
for the platform) — one `tenant_domain` row per panel domain, no separate API
host. `Origin` is still never consulted (ADR-0025). Once the panel holds a
session, the session claim answers regardless of host.

**Not built yet:** C-01's `X-Tenant-Id` on a *platform-staff* token. What ships
here is the same header restricted to a verified service caller — see
`open-questions.md`.

### A domain says what it is for, and a non-panel door serves nothing (F-1212)

`tenant_domain` carries a `purpose` — `panel`, `subscription` or `assets`
(catalog 13.1 / C-16). **Every purpose resolves to the same tenant.** Purpose is
not a second tenancy and it never changes the answer above; it changes what may
be *served* once the answer is known.

The resolved answer therefore carries `surfacePurpose`, and it is set **only
when a `tenant_domain` row matched the host**. Its absence and the value `panel`
are different facts and are treated differently:

| the request | `surfacePurpose` | what is served |
|---|---|---|
| matched a `panel` row | `panel` | everything |
| matched a `subscription` / `assets` row | that value | only that purpose's allowlist |
| matched no row — a claim answered alone, as an internal caller's does | absent | everything |

**It is a fact about the surface, never about `via`.** A tenant's own session
presented on that tenant's subscription domain resolves cleanly through the
`session` entry of the chain and is exactly the request this rule refuses, so
`surfacePurpose` travels with a claim-answered resolution too. A check that read
`via` would let every signed-in browser through the door it is meant to close.

`TenantGuard` enforces it, as the third of its refusals, with the **same neutral
404** an unknown host gets — a subscription domain must not reveal that a panel
lives elsewhere any more than a stranger's host may (F-1210). It runs before the
`@TenantAgnostic` exemption, because the refusal is about the door and not about
the route.

**The allowlist for `subscription` and `assets` is empty in `auth-service`, and
that is the answer rather than a gap.** Every controller here is `/auth/*` or
`/internal/*` — panel, operator and service-caller routes without exception.
The `/sub` link catalog 13.1 names belongs to `network`, which has no service
yet; its prefix goes into `SERVED_PATHS` (`app/tenant/tenant.ts`) with it. The
gate is the same seam's third input ([contract.onboarding.md](contract.onboarding.md), F-018-ag).

**Every host reaches the panel now** (F-066-u), so the panel mirrors this rule
(F-066-x): `site-pwa` asks `GET /api/public/tenant/serves-panel` before it renders and returns
a bare 404 on `serves: false`. A reseller's CNAME target serves nothing at all,
on any path (ADR-0063). Both are in
[contract.onboarding.md](contract.onboarding.md) "The door a gated reseller is served on".

## The Credential Vault (implemented — ADR-0026)

Every third-party secret a tenant owns — bot token, gateway key, SMS
credentials, panel login — is stored encrypted under that tenant's own data
key, and is read back only by the code about to use it. It has consumers this
file does not (`messenger`, `network`, `billing`) and a rule set of its own, so
it lives beside this one: **[contract.vault.md](contract.vault.md)** (§10).

## Emits (events)

None planned yet. Metering + domain verification are intended as `automation`
workers.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `ownerUserId`, `tenant_staff_member.userId` | cannot create tenant/staff |
| redis-keyspace | `tenant:host:*` / `tenant:id:*` — the resolution cache, written and retracted through `RedisKeys` (C-03). A `tenant:host:*` entry now carries `purpose`; one written before that column existed fails the shape check on read and is re-looked-up, so the change crossed its deploy without a keyspace version bump | resolution keeps working from Postgres; reads fail open (above) |
| billing | `PaymentProviderName` / `GatewayCategory` enums for `tenant_gateway_config` | — |

## Guarantees (intended)

- Every feature execution checks `tenant_feature_entitlement` even if the feature
  is globally enabled.
- `tenant_billing_wallet.cachedBalance` is a cache; `tenant_billing_transaction`
  is the truth (ADR-0002), with optimistic-lock `version`.
- `platform_owner` is unique (planned CHECK/trigger, schema "section 99").

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
