---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-07
---

# Contract — panel-web: a reseller domain's certificate and CDN (EDGE-1-f)

A topic file of [contract.md](contract.md) (§10). The domains screen itself —
route, calls, refusals, the host an owner types, "check now" — is
[contract.resellers.md](contract.resellers.md) "A reseller's workspace", rules
18–22, which hold here too. This file is what ADR-0129 added to it: the step
after `verified`, a reseller's own CDN, and the live re-read. The rules behind
each are [tenant/contract.domains.md](../../domains/tenant/contract.domains.md)
"The edge lifecycle". Files: `ResellerDomainsView.tsx`, `my-resellers/_lib/domains.ts`.

## Rules

| # | Rule | Why |
|---|---|---|
| D1 | **A subdomain, never an apex.** `isApex` (two labels, `example.com`) is refused before the call with `errors.apex`. A two-label suffix (`example.co.uk`) is not told apart without the public suffix list | below Enterprise a Custom Hostname cannot be an apex (ADR-0129 Consequences) |
| D2 | **The two records** — the TXT and the CNAME to `<slug>.edge.<domain>` — and the edge's ownership TXT while the edge asks for it (EDGE-1-d) are one table; the page says the third is for a reseller's own CDN only | ADR-0129 (2), (4) |
| D3 | **The step after `verified`** (`EdgeStep`): the edge status with its label (`EDGE_STATUS_KEYS`, Prisma's `TenantDomainEdgeStatus`, read from the schema by the spec), what it means (`EDGE_HINT_KEYS`) and, when the provider gave one, its reason (`edge.lastError`, verbatim, `dir="ltr"`). Shown once the domain routes or the edge left `none` | ADR-0129 (6): `failed` with what was expected and found |
| D4 | **"Live" only when verified and `issued`** (`isLive`); `statusHint.verified` says the domain goes live with its certificate | ADR-0129 (3) |
| D5 | **"Check now" also on a verified domain whose edge `failed`**: the same route starts the edge over (tenant `contract.domains.md`) | one button, one route; no second endpoint for a retry |
| D6 | **A reseller's own CDN** (`CdnSettings`, closed by default): origin `<slug>.edge.<domain>`, Host and SNI the domain itself, WebSocket on, and "never cache pages for signed-in users" — the `cache` check line is what fails a CDN that does | ADR-0129 (4), (8); ADR-0063: the target serves nothing |
| D7 | **Live re-read** (C-14, RT-1-e): `useLiveReread` on `tenant.domain.changed` (`DOMAIN_LIVE_EVENTS`) on the viewer's `user:` channel (the reseller's owner) and, with `realtime.tenant.read`, the platform's `tenant:` channel (`domainLiveChannels`). The read is quiet — no skeleton, a failure keeps the list — and the refresh button stays | the page is on the platform's panel; the reseller's own `tenant:` channel reaches nobody here |
| D8 | **Every check line has a label**, `cache` included (`CHECK_LINE_KEYS`, read from `CheckName` by the spec) | a new line is a blank row otherwise |

Strings: `common.resellerDomains.edge.*`, `.cdn.*`, `.lines.cache`,
`.errors.apex`, `.live`, en and fa. Not built: a reseller's own staff
(`member`, whose session is the reseller's) hear no domain event and re-read on
mount and on refresh.
