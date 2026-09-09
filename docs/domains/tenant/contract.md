---
id: tenant
layer: domain
status: active
version: 2
updated: 2026-09-09
---

# Contract — tenant

**One operation is implemented; the rest are intended.** *Resolve tenant by
host* is real code (`app/tenant/`, F-061-a). Every other row in *Provides* is
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
| **resolve tenant by host** — implemented | request host | `{id, slug, via}` or `null` | sync | none: `null` is the answer |
| check entitlement | tenantId, featureKey | allowed / denied (+ source, expiry) | sync | — |
| verify custom domain | tenantId, domainValue | verification status | async (DNS TXT / ArvanCloud) | token mismatch |
| charge tenant | tenantId, reason, amount | `tenant_billing_transaction` (append-only) | sync tx | insufficient / wallet missing |
| meter usage | tenantId, meterKey, quantity, period | `tenant_usage_meter` row | async (worker) | — |
| set BYO gateway/SMS/bot config | tenantId, encrypted credentials | config row, `pending` verification | sync | — |

## Resolve tenant by host (implemented — ADR-0020)

`TenantResolverService.resolve(host)`, attached to every request by
`TenantMiddleware` and read with `resolveTenant(req)`. The host is
`req.hostname`, lowercased with the port and any trailing root dot removed.

1. A `tenant_domain` row whose `domainValue` equals that host resolves — a
   `subdomain` as it stands, because the platform issued it; a `custom_domain`
   **only** when `verificationStatus` is `verified`, because the reseller
   claimed it and ownership has to be proven. An unverified custom domain is
   treated as an unknown host, not as an error.
2. Otherwise the deployment's `DEFAULT_TENANT_SLUG`. `via` says which of the two
   answered, which is the only way a log can tell a real match from a fallback.
3. Neither → `null`. That is a configuration bug (no tenant carries the
   configured slug), and the honest answer is no tenant; callers refuse rather
   than substitute one.

**The fallback is a production footgun, and it is accepted (ADR-0020).** It
cannot tell a misconfigured host from an unknown one, so on a deployment that
serves resellers `DEFAULT_TENANT_SLUG` must be set deliberately and never left
at `platform_owner`.

Resolved hosts are cached in-process for `TENANT_CACHE_TTL_MS` (60s). There is
no invalidation path because there is no writer yet — adding and verifying a
domain is F-018 — and the TTL is what makes a newly verified domain work
without a restart.

**Known limit:** the host is the one the *API* was called on. The panel calls
the API cross-origin (`site-pwa/src/lib/auth-api.ts`) at `api.<domain>`, so a
reseller needs a `tenant_domain` row for their API host; the panel's own domain
arrives as `Origin`, which nothing consults. See `open-questions.md`.

## Emits (events)

None planned yet. Metering + domain verification are intended as `automation`
workers.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `ownerUserId`, `tenant_staff_member.userId` | cannot create tenant/staff |
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
