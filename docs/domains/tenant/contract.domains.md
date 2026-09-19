---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-09-18
---

# Contract — tenant / custom domains

A topic file of `contract.md` (§10). A reseller adds a custom domain and
proves it (F-018-i, catalog 13.2 steps 1-3 and 6). Code:
`txnet-backend/tenant-service/src/app/domains/`. Roles (`primary` / `standby`),
the `/sub` domain, TLS and the CDN setup are other ids of area 13, not here.

## The routes

| Route | Who | Answer |
|---|---|---|
| `POST /api/tenants/:id/domains` `{domainValue, purpose?}` | the reseller's owner, or platform staff with `tenant.manage` | `201` the domain, `pending`, with its TXT record and CNAME target |
| `GET /api/tenants/:id/domains` | same | the reseller's custom domains, each with its last check |
| `POST /api/tenants/:id/domains/:domainId/check` | same | `pending` / `failed` -> `verifying`; any other status is returned as is |
| `POST /api/internal/tenant-domains/check-due` | `worker-service` (`ServiceOnlyGuard`) | `{due, verified, waiting, failed, revalidated, revalidating, dropped, errors}` |
| `GET /api/tenant-domain-probe?n=<hex nonce>` | public, no `my-auth` (Traefik priority 130) | `{host, nonce}` on a host with a `tenant_domain` row; the neutral 404 elsewhere (F-1210) |

The domain view: `{id, domainValue, purpose, status, record: {type: 'TXT',
name, value}, cnameTarget, verifiedAt, lastCheckedAt, lastCheck}`.
`record.name` is `_domain-verification.<host>` — a neutral label, since a
reseller's DNS zone is public and must not name the platform (catalog 13.4).
`cnameTarget` is the reseller's own `<slug>.edge.<domain>` (ADR-0060 (6)) —
its only platform host, which serves nothing itself (ADR-0063).

**Who** is `ResellerAccess` (F-061-h, invariant 21): the path's reseller, never
the caller's tenant — so the owner reaches it with the same session on the
platform's domain and on their own. The owner is held to that reseller's status
matrix ([rules.md](rules.md)): a suspended reseller's owner lists (`read`) but
cannot add or check (`staffWrite`); platform staff can.

Refusals: `not_allowed` 403 (neither the owner nor staff — including when the
reseller does not exist, which only staff learn: `reseller_not_found` 404),
`reseller_suspended` 403 (the owner, a write),
`domain_not_found` 404, `reseller_terminated` / `domain_taken` /
`domain_reserved` (a host inside `$DOMAIN_NAME`) 409. A host with a port, an IP
or one label is a 400 at the schema.

## The states

| status (view) | stored as | routes? | leaves by |
|---|---|---|---|
| `pending` | `pending` | no | the tenant asks for a check |
| `verifying` | `verifying` | no | a passing check -> `verified`; `DOMAIN_VERIFY_WINDOW_HOURS` (72) after the request -> `failed` |
| `verified` | `verified` | **yes** | a re-validation missing the TXT record -> `revalidating` |
| `revalidating` | `verified` + `revalidatingSince` | **yes** | the record back -> `verified`; `DOMAIN_REVALIDATION_GRACE_HOURS` (72) -> `pending`, token kept |
| `failed` | `failed` | no | the tenant asks for a check again |

**`revalidating` is a column, not a status**, so every routing reader —
`auth-service`'s resolver, `billing-service`'s callback and return address —
keeps checking `verified` alone, and a new reader cannot forget a second value.

## What a check is

A `verifying` domain passes when all four lines pass; each line stores what it
expected and what it found (catalog 13.2 step 3 — the support ticket this row
exists to prevent):

| line | expected | passes when |
|---|---|---|
| `txt` | `_domain-verification.<host> TXT <token>` | the token is among the TXT strings there |
| `cname` | `<slug>.edge.<domain>` | the CNAME names **no other** reseller's target. A CDN in front answers DNS with its own name; the target is then its origin, visible only to the probe lines |
| `http`, `https` | `200 as <host>` | the platform answered the probe with the nonce this check sent (redirects followed), and the request arrived **as the domain itself**. Arriving as the reseller's own target fails too (ADR-0063): the target serves nothing, so a CDN that forwards it would break every page — the line names the host the CDN sent |

A `verified` domain is re-validated on its **TXT record only**, every
`DOMAIN_REVALIDATE_EVERY_HOURS` (6), and every tick while `revalidating`:
catalog 13.2 step 6 is about a lost record, and a CDN outage is not one. A DNS
lookup that errors (not "no record") is a sweep `error` and changes nothing.

## Rules

1. **Only `verified` routes** (invariant 5). A new custom domain, a
   `verifying` one and a `failed` one resolve as unknown hosts.
2. **A change of what routes deletes `tenant:host:<host>` in its own
   transaction** — `verified`, the drop to `pending`, and adding a domain (a
   cached *no tenant* goes with it). A Redis that cannot be reached rolls the
   change back and the sweep counts an `error`.
3. **Proven first wins.** A host held as a `subdomain`, or `verified` by any
   tenant, is `domain_taken`. Another tenant's unproven claim (`pending`,
   `verifying`, `failed`) is replaced by the new one, with a new token — a
   squatter cannot hold a domain by never proving it.
4. **A sweep write is guarded on the status it read.** A row claimed or
   re-requested meanwhile is left alone, so two sweeps are safe.
5. **The platform never registers, buys or controls a tenant's DNS** (catalog
   13.2). It only reads public DNS and requests the domain from outside.
6. **`verified` is what opens the reseller too.** Until one `panel`
   `custom_domain` is `verified`, the onboarding column closes registration,
   sales, end-user deposits and `/sub`
   ([contract.onboarding.md](contract.onboarding.md), F-018-l). A change of
   verification status notifies `tenant_status_changed` as a status change
   does, so the gate follows the sweep at once.

## Consumers

| Consumer | Uses |
|---|---|
| `automation` (`tenant_domain_verification` job, seeded `*/5`) | `check-due` |
| panel-web | the onboarding console's checklist is `GET /api/tenants/:id/onboarding` (F-018-l), on the platform's own panel — a gated reseller's platform subdomain serves nothing (F-066-x) |
| `auth-api` resolver, `billing` callback / return address | read `verified` only; unchanged |

## Setting up the CDN (ArvanCloud)

The platform and its resellers use ArvanCloud (user, 2026-09-19). Two zones
take part, and the gateway's address must appear in neither:

| zone | record | CDN proxy | why |
|---|---|---|---|
| the platform's | `*.edge.<domain>` -> the gateway | **on** | a lookup of any target answers Arvan's addresses, never the gateway's |
| the reseller's | its domain, CNAME -> `<slug>.edge.<domain>` | **on** | the reseller's certificate and address are Arvan's |

- **Keep the visitor's host.** At the reseller's zone, the origin must receive
  `Host: <the reseller's domain>`, not the target's name. A zone that sends the
  target fails the `https` line with `200 as <slug>.edge.<domain>` — that line
  is the test, and ADR-0063 is why nothing else will work.
- **Untested:** whether Arvan proxies a record whose origin is a name Arvan
  itself proxies in another account. Prove it with one reseller before
  onboarding more; the domain check's `https` line says whether it arrived.
- **Nothing here is code.** The gateway accepts any host (ADR-0060 (3)); which
  host is served is `TenantGuard`'s call. Limiting the gateway to Arvan's
  address ranges, so it cannot be reached around the CDN, is a firewall rule.
