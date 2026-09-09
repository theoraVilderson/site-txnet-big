---
id: tenant
layer: domain
status: active
version: 7
updated: 2026-09-09
---

# Contract — tenant

**One operation is implemented; the rest are intended.** *Resolve tenant by
claim* is real code (`app/tenant/`, F-061-a, F-066-c, F-066-d). Every other row in *Provides* is
still a shape derived from `txnet-backend/prisma/domains/tenant.prisma`, with no
service behind it — the `(intended)` marker on that table is what tells them
apart, and it is the thing to check before calling one.

## TL;DR

A Tenant is an isolation + branding boundary. Exactly one is `platform_owner`;
the rest are `reseller`. The platform bills tenants (subscription or metered
usage); tenants collect from their own end users through their own gateway
(ADR-0006). A central entitlement check gates every feature per tenant.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| **resolve tenant by claim** — implemented | `{host?, session?, bot?}` | `{id, slug, via}` or `null` — `null` means *no tenant*, never a fallback | sync | `TenantClaimConflict` when a claim and its surface disagree |
| check entitlement | tenantId, featureKey | allowed / denied (+ source, expiry) | sync | — |
| verify custom domain | tenantId, domainValue | verification status | async (DNS TXT / ArvanCloud) | token mismatch |
| charge tenant | tenantId, reason, amount | `tenant_billing_transaction` (append-only) | sync tx | insufficient / wallet missing |
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
   than to an id nobody owns.
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
| claim disagrees with surface | `403 tenant.claimMismatch` | that this session does not belong here — never which tenant does |
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

**No caller invalidates anything yet, because no code writes a `tenant_domain`
row** — domain administration is F-018, and `prisma/seed.js` and the e2e
harness write rows directly for bootstrapping. The obligation above is on
F-018, F-102 and F-113 when they land; until then the backstop TTL is the only
thing in play, which is the same position ADR-0025 accepted for the Redis round
trip.

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

**Known limit:** the host is the one the *API* was called on. The panel calls
the API cross-origin (`site-pwa/src/lib/auth-api.ts`) at `api.<domain>`, so a
reseller needs a `tenant_domain` row for their API host; the panel's own domain
arrives as `Origin`, which nothing consults — and never will (ADR-0025). Once
the panel holds a session, the session claim answers regardless of host.

**Not built yet:** C-01's `X-Tenant-Id` on a *platform-staff* token. What ships
here is the same header restricted to a verified service caller — see
`open-questions.md`.

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
| redis-keyspace | `tenant:host:*` / `tenant:id:*` — the resolution cache, written and retracted through `RedisKeys` (C-03) | resolution keeps working from Postgres; reads fail open (above) |
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
