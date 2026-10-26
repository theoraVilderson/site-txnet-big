---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-10-26
---

# Contract — tenant / the path a custom domain takes

A topic file of `contract.md` (§10), beside [contract.domains.md](contract.domains.md),
whose routes, states and checks this file extends. ADR-0165 point 7 (amends
ADR-0129 decision 4). Code: `txnet-backend/tenant-service/src/app/domains/`
(`domain-path.ts`, `domain-prober.ts`). Rows NIN-1-e1 … e3.

## The two paths (NIN-1-e1)

| `path` | the reseller sets | target | Custom Hostname | in a national-internet cut |
|---|---|---|---|---|
| `platform_cdn` (default; every domain made before) | CNAME -> target, or its own CDN with the target as origin | `<slug>.edge.$DOMAIN_NAME` | yes (ADR-0129) | closes |
| `own_edge` | its own account at an approved edge (Arvan first): origin = target, port 8443, HTTPS, the visitor's host, cloud on | `<slug>.edge.$DOMESTIC_DOMAIN_NAME` | **never** | stays open |

- **No reseller's domain enters an account of ours** (user, 2026-10-25): not
  Arvan's by NS delegation, not its CNAME Setup. The own-edge target is
  `*.edge` of the domestic zone, an A record with the cloud **off**
  (`edge_zone.py arvan`, hosting O14), so a reseller's Arvan never chains
  through ours. Like every target it serves nothing as itself (ADR-0063): no
  `tenant_domain` row names it, so it gets the neutral 404.
- **Own edge is offered** only when `DOMESTIC_DOMAIN_NAME` is set and
  `OWN_EDGE_NAMES` names at least one edge: the domestic door's rows of
  `scripts/edge/edges.json`, held equal to tenant-service's compose by
  `tools/k8s_render_traefik_test.py`. Adding an edge is a row there, not code (C-18).
- A host inside either platform domain is `domain_reserved`.

## Routes

| Route | Answer |
|---|---|
| `GET /api/tenants/:id/domains/paths` | `[{path, target, port, edges}]`: ours first; `own_edge` (port 8443, `edges` the approved names) only when offered |
| `POST /api/tenants/:id/domains` `{domainValue, purpose?, path?}` | as before; `path` defaults to `platform_cdn` |
| `PUT /api/tenants/:id/domains/:domainId/path` `{path}` | the domain view; the same path again changes nothing |

Who: as every domain route (`ResellerAccess`, `read` for `paths`, `staffWrite`
for the writes). New refusal: `own_edge_unavailable` 409, the path not offered.
The domain view gains `path`, `switching` (below), and `cnameTarget` is its
path's target.

## Changing path

- **Not verified:** only the path the next check runs on changes.
- **Verified:** it keeps routing (its TXT still proves it; routing never
  depends on the door), `pathSwitchedAt` is set, and the sweep runs the new
  path's **whole** check — every tick for `DOMAIN_VERIFY_WINDOW_HOURS`, then on
  the re-validation clock — until it passes, which clears it. Its TXT line
  still drives re-validation and the drop to `pending` (which clears it too).
- **While switching, its Custom Hostname stays**, so visitors still reaching
  Cloudflare during the reseller's DNS move are served: the move costs no
  downtime. Once an own-edge domain is not switching, the edge lifecycle
  removes its hostname, and never registers one.
- Every change writes `tenant.domain.changed`; clearing `pathSwitchedAt` does too.
- **Live** is `verified` and edge `issued`, or `verified` on `own_edge`
  (no certificate of ours): the owner is told when it lands (RT-1-e2).

## Consumers

| Consumer | Uses |
|---|---|
| panel-web `/my-resellers/:id/domains` | `paths`, the `path` of add, `PUT …/path` (NIN-1-e3) |
| `auth-api` resolver, billing callback | unchanged: they read `verified` alone |
