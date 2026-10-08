---
id: tenant
layer: domain
status: active
version: 2
updated: 2026-09-19
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
| `POST /api/internal/tenant-domains/check-due` | `worker-service` (`ServiceOnlyGuard`) | `{due, verified, waiting, failed, revalidated, revalidating, dropped, edgeRegistered, edgeIssued, edgeWaiting, edgeFailed, edgeRemoved, errors}` |
| `GET /api/public/tenant/domain-probe?n=<hex nonce>` | public (ADR-0065, `@PublicRoute` doors `'none'`: an unverified domain has no surface yet, so the handler checks the row; `system`, so no status refuses it). `GET /api/tenant-domain-probe` is **@deprecated since 2026-09-19**, remove after the next release | `{host, nonce}` on a host with a `tenant_domain` row; the neutral 404 elsewhere (F-1210). The nonce is `n`, or the `x-domain-probe` header for the `cache` line; always `Cache-Control: private, no-store` |

The domain view: `{id, domainValue, purpose, status, record: {type: 'TXT',
name, value}, cnameTarget, verifiedAt, lastCheckedAt, lastCheck, edge: {status,
record, lastError}}`. `edge.record` is the CDN's ownership TXT while the CDN
still asks for it, else null (EDGE-1-d). The page lists it as a third record and
says it is needed only behind the reseller's own CDN, which answers 409 until
it is in place.
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
or one label is a 400 at the schema. Past the reseller's limit on custom
domains (F-019-q, ADR-0106 `custom_domains_max`, default 5 — each one is a
certificate): `reseller_limit_reached` 409, `facts {key, limit, used}`, for its
own people only; the platform's staff pass. Counted under a per-reseller lock
in the add's transaction; adding again a domain it already has is answered, never refused.

## The states

| status (view) | stored as | routes? | leaves by |
|---|---|---|---|
| `pending` | `pending` | no | the tenant asks for a check |
| `verifying` | `verifying` | no | TXT + CNAME passing -> `ownershipProvenAt`, held at the edge (below); a passing check -> `verified`; `DOMAIN_VERIFY_WINDOW_HOURS` (72) after the request -> `failed`, proof cleared |
| `verified` | `verified` | **yes** | a re-validation missing the TXT record -> `revalidating` |
| `revalidating` | `verified` + `revalidatingSince` | **yes** | the record back -> `verified`; `DOMAIN_REVALIDATION_GRACE_HOURS` (72) -> `pending`, token kept |
| `failed` | `failed` | no | the tenant asks for a check again |

**`revalidating` is a column, not a status**, so every routing reader —
`auth-service`'s resolver, `billing-service`'s callback and return address —
keeps checking `verified` alone, and a new reader cannot forget a second value.

## What a check is

A `verifying` domain passes when all five lines pass; each line stores what it
expected and what it found (catalog 13.2 step 3 — the support ticket this row
exists to prevent):

| line | expected | passes when |
|---|---|---|
| `txt` | `_domain-verification.<host> TXT <token>` | the token is among the TXT strings there |
| `cname` | `<slug>.edge.<domain>` | the CNAME names **no other** reseller's target. A CDN in front answers DNS with its own name; the target is then its origin, visible only to the probe lines |
| `cache` | each request answered on its own | two requests to one `https` URL, each with its own nonce in `x-domain-probe`, each got its own answer. A CDN that caches by URL whatever the request carries serves one signed-in user's page to another: `found: ['cached']` (ADR-0129 (8), EDGE-1-e) |
| `http`, `https` | `200 as <host>` | the platform answered the probe with the nonce this check sent (redirects followed), and the request arrived **as the domain itself**. Arriving as the reseller's own target fails too (ADR-0063): the target serves nothing, so a CDN that forwards it would break every page — the line names the host the CDN sent |

A domain with an `edge.record` gets a sixth line, `edge_owner`: that TXT holds
the value, or the CNAME names the target straight (then the CDN proves the
hostname by it). It is **advisory**: shown, never part of `ok`, so a missing
CDN record never holds back or drops the domain's own proof (EDGE-1-d).

A `verified` domain is re-validated on its **TXT record only** (and the advisory
`edge_owner` line), every
`DOMAIN_REVALIDATE_EVERY_HOURS` (6), and every tick while `revalidating`:
catalog 13.2 step 6 is about a lost record, and a CDN outage is not one. A DNS
lookup that errors (not "no record") is a sweep `error` and changes nothing.

## The edge lifecycle (EDGE-1-e, ADR-0129 (6); two stages, EDGE-1-n, amendment 3)

Run by `check-due` after the checks, so a domain verified this tick is
registered this tick; only with `EDGE_LIFECYCLE_ENABLED=true` (off until
go-live, EDGE-1-i, "The CDN and go-live" below). **Live = `verified` and edge `issued`.**
**Held** = `verified`, or `verifying` with `ownershipProvenAt`: the probe lines
reach us through the edge, which answers 409 for a host it does not hold, so a
domain is held once TXT and CNAME prove it, and verified once they pass.

| edge step | read | leaves by |
|---|---|---|
| `none` (held) | every tick | written `registering`, then `register(host)` -> the answer's step; a hostname left from a failure is removed first |
| `registering` | every tick | a register that threw keeps `edgeLastError` and is sent again |
| `issuing` | every tick | `status(id)` -> `issued` / `failed` / still `issuing` |
| `issued`, `renew_failed`, `failed` | every `DOMAIN_REVALIDATE_EVERY_HOURS` | `status(id)`; renewal is Cloudflare's, `renew_failed` is read, never retried |

- A hostname the provider no longer has is written `none` and registered again:
  our table is the list. A domain no longer held (`pending`, `failed`) is
  removed from the CDN and its edge columns cleared; so is a replaced claim's.
- `failed` keeps what the provider said (`edgeLastError`). A check the tenant
  asks for on a `verified` domain whose edge `failed` sets it back to `none`.
- Every write is guarded on the step it read. A provider error is a sweep
  `error`; the next tick tries again.
- **Every change of status or edge step writes `tenant.domain.changed`** in its
  transaction ([live-events RT-1-e](../../platform/realtime/contract.live-events.md)):
  the owner's `user:` channel and the platform's `tenant:` channel.

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
| panel-web | the three routes above, on `/my-resellers/:id/domains` (F-066-w2, `resellerDomainsApi`), re-read on `tenant.domain.changed` (EDGE-1-f); the onboarding console's checklist is `GET /api/tenants/:id/onboarding` (F-018-l), on `/my-resellers/:id` (F-066-w). Both on the platform's own panel — a gated reseller's platform subdomain serves nothing (F-066-x) |
| `auth-api` resolver, `billing` callback / return address | read `verified` only; unchanged |

## Cloudflare for SaaS — what EDGE-1-a proved (dev, 2026-10-07)

Test domain `edgetest.chillshop.ir` (DNS at ArvanCloud), Custom Hostname on
`txnet.cyou` with `ssl.method: http`, CNAME to `chillshop.edge.txnet.cyou`.
`*.edge.<domain>` is a proxied CNAME to the fallback origin
(`EDGE_FALLBACK_ORIGIN`), a proxied A record to the origin on 443 — no tunnel
(ADR-0129 amendment 1).

| path | hostname ownership | certificate | `http`/`https` line | WebSocket `/realtime` |
|---|---|---|---|---|
| CNAME straight to the target | automatic (the CNAME) | one SAN, Google Trust Services, ~2 min | arrived as the domain | 101 |
| Arvan in front (Host = the domain) | **needs `_cf-custom-hostname.<host> TXT <value>`** — Arvan answers DNS with its own addresses, and until then Cloudflare answers 409 | issued over HTTP **through Arvan** in ~30 s | `200 as <host>`, both schemes | 101 |

- **Behind a reseller's CDN the reseller adds one record more**, Cloudflare's
  ownership TXT (its value is per registration; re-registering changes it).
  No TXT for the certificate and no DCV delegation: HTTP validation reaches
  Cloudflare through Arvan, so renewal is expected to need nothing. The record
  is stored as `edgeOwnershipName`/`edgeOwnershipValue` from each provider
  answer (`edgeColumns`) and cleared once Cloudflare stops asking (EDGE-1-d).
- Untested: renewal itself (first one ~2026-12), and a CDN set to force HTTPS
  on `/.well-known/` — HTTP validation through it is unproven.

**The port (EDGE-1-c).** `domains/edge/edge-provider.ts`: `register(host)`,
`status(id)`, `remove(id)`. `register` of a host the zone already holds answers
that registration (Cloudflare `1406`), so re-sending our table never doubles a
hostname. A hostname that is gone is `null` to `status` and done to `remove`.
Each registration is its own hostname and certificate, never a shared SAN
(F-109). Cloudflare to `edgeStatus`: hostname `active` with certificate
`active`/`pending_expiration` -> `issued`; certificate `expired` ->
`renew_failed`; hostname `blocked`/`moved`/`deleted` or certificate
`*_timed_out`/`deleted` -> `failed`; else `issuing`. The driver is used when
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` are both set. Without them every
call refuses (`EdgeProviderError`). Proven live on `txnet.cyou`, 2026-10-07.

## The CDN and go-live (EDGE-1-i, ADR-0129)

The platform runs the CDN (Cloudflare for SaaS); a reseller only points
records at it. This replaces the per-reseller ArvanCloud zones of 2026-09-19 (ADR-0060).

| zone | record | proxy | made by |
|---|---|---|---|
| the platform's | `EDGE_FALLBACK_ORIGIN` (`edge-origin.<domain>`) A -> the origin | on | `scripts/edge/edge_zone.py apply` |
| the platform's | `*.edge.<domain>` CNAME -> `EDGE_FALLBACK_ORIGIN` | on | the same run |
| the platform's | Custom Hostnames fallback origin = `EDGE_FALLBACK_ORIGIN` | — | the same run |
| the reseller's | ownership TXT, and its domain CNAME -> `<slug>.edge.<domain>` | — | the reseller, from the domains page (panel-web `contract.reseller-domains.md`) |

- **Our table is the list.** With `EDGE_LIFECYCLE_ENABLED=true` the job
  registers every `verified` domain (the edge lifecycle above). Nothing is
  registered by hand, so go-live needs no import step.
- **Keep the visitor's host** (ADR-0063). A reseller's own CDN sends its domain
  as `Host` and SNI; the check's `https` line is the test.
- **No record shows the origin's address DNS-only.** `edge_zone.py` warns on
  each one it finds and changes none (mail has to stay DNS-only: move it off the
  origin's address, or accept that it is public).
- `edge_zone.py` refuses a fallback outside the zone or under `*.edge`, and two
  records for one name. `plan` and `status` change nothing.

**Go-live, in order** (on the production zone, when the user schedules it; dev `txnet.cyou` has held
steps 2-6 since 2026-10-07, and `edge_zone.py plan` there finds nothing to do):
1. *User:* add the zone to the Cloudflare account (held outside Iran), check
   every Arvan record was imported, switch the nameservers at the registrar,
   and wait until `dig NS` answers Cloudflare. SSL/TLS mode Full (strict): the
   pull must reach 443, where the pull certificate is checked.
2. The prod `CLOUDFLARE_API_TOKEN` gains the zone (DNS Edit, SSL and
   Certificates Edit). `.env.prod`: `CLOUDFLARE_ZONE_ID`,
   `EDGE_FALLBACK_ORIGIN=edge-origin.<domain>`.
3. `ENV_FILE=.env.prod EDGE_ORIGIN_IP=<address> scripts/edge/edge_zone.py plan`,
   then `apply`.
4. `ENV_FILE=.env.prod scripts/edge/origin-pull.sh upload` (hosting O1-O2: on
   the prod host, `issue` first unless dev's pair is copied there).
5. `.env.prod`: `EDGE_ORIGIN_PULL=required`, `EDGE_LIFECYCLE_ENABLED=true`;
   restart the gateway and `tenant-service`.
6. Swarm host: `cloudflare_firewall.py install` and `apply` (hosting O7).
7. *User:* the new address from the host's provider (the old one is in public
   DNS history). `ENV_FILE=.env.prod scripts/edge/edge_zone.py repoint OLD NEW`
   moves every A record on it, then the old address is released.

Done when `edge_zone.py status` and `origin-pull.sh status` show all three and
AOP on, a handshake to the new address without the certificate is refused, and
one reseller domain's check is green with edge `issued`.
