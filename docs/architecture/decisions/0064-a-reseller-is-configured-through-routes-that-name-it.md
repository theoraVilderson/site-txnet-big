---
id: adr-0064
status: accepted
updated: 2026-09-19
---

# ADR 0064 — A reseller is configured through routes that name it

- **Status:** accepted 2026-09-19 with F-066-w (user)
- **Date:** 2026-09-19
- **Affects units:** tenant, billing, catalog, automation, panel-web
- **Amended by:** [ADR-0104](0104-platform-staff-see-a-resellers-people-only-with-its-consent.md) — platform staff reach a reseller's people only with its consent

## Context

ADR-0063 left a gated reseller one place to be configured: the platform's own
panel, where its owner's account lives (ADR-0059). But the configuration
screens there — `/gateways`, `/catalog`, and a bot screen that does not exist
yet — act on the **session's** tenant. For the owner that is the platform
owner's tenant, never their reseller's. So F-066-w's checklist (domain,
gateway, bot, pricing) had nowhere to send three of its four steps: the owner
of `vpnshop` opening `/gateways` sees the platform's gateways, not vpnshop's.

Only tenant-service already had the answer: its self-service routes take the
reseller from the path and admit by invariant 21 (`ResellerAccess`).

## Decision

1. **Every route that configures a reseller names it in its path** —
   `/api/<service>/tenants/:tenantId/...` — and never reads it from the
   session or the host. The existing ambient routes stay as they are for a
   tenant configuring itself.
2. **One admission rule, shared.** Invariant 21 (the owner, a live staff seat
   with `tenant.manage`, or the platform owner's staff with `tenant.manage`;
   judged by that reseller's status matrix) moves to `shared-core`, and every
   such route calls it. No service keeps a copy (F-066-w1).
3. **The work runs in the named reseller's scope** once admitted, so RLS sees
   the reseller's tenant, not the caller's.
4. **The panel gets one workspace per reseller**, `/my-resellers/:id`, on the
   platform's panel: the onboarding console (F-066-w) and one screen per step,
   each reusing the ambient screen's components over the path-scoped route.

## Consequences

- Positive: the owner configures a gated reseller from the platform panel, and
  the same routes serve a reseller's staff and platform support unchanged, and
  a second owner later (F-018-af) changes the rule in one place.
- Negative / accepted cost: each configuring service gains a second route set
  beside its ambient one — rows F-066-w3 (gateways), F-066-w5 (bots),
  F-066-w7 (catalog) — and the panel a screen per step (w2, w4, w6, w8).
- What this forecloses: a session scoped to the reseller's tenant on the
  platform's host.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| The owner "enters" the reseller's tenant on the platform panel (a session whose tenant is the reseller) | cheapest today — every screen works unchanged — but it is ADR-0059 run backwards: every ambient route becomes a way to reach a reseller's data on the platform's host, and every new screen inherits that to be re-checked |
| The console links nothing until later | the owner learns what is missing and cannot act on it |

## Revisit trigger

A reseller owned by more than one person or by another reseller (F-018-af,
F-901): the shared admission rule is where that lands.
