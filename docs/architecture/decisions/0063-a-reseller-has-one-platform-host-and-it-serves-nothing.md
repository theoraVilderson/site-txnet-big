---
id: adr-0063
status: accepted
updated: 2026-09-19
---

# ADR 0063 — A reseller has one platform host, and it serves nothing

- **Status:** accepted 2026-09-19 with F-018-ai (user)
- **Date:** 2026-09-19
- **Affects units:** tenant, auth-api, panel-web
- **Amends:** ADR-0060 (6) — the CNAME target no longer serves the panel;
  `tenant/contract.admin.md` (reseller creation wrote two subdomain rows)

## Context

A reseller was created with two `subdomain` rows on the platform's name:
`<slug>.<domain>`, a panel host, and `<slug>.edge.<domain>`, the target its
own domain is CNAMEd to (ADR-0060 (6)). F-018-ag and F-066-x closed the first
while the reseller had proved no domain, and it opened again once one was.

A platform name a reseller can use is one it can hand its customers. A filter
or an abuse report on that name lands on the platform's domain, and takes every
reseller parked on it — and the platform's own panel — down together. That is
the risk D-01 ("no platform domain or subdomain is ever served to an end user")
exists to remove, and a host that opens after verification keeps it.

## Decision

1. **One platform-issued host per reseller: `<slug>.edge.<domain>`.** No
   `<slug>.<domain>` is created, and migration
   `20260919000500_reseller_panel_subdomain_removed` deletes the old ones.
2. **The target serves nothing, ever.** It exists so the reseller's domain can
   point at the gateway (CNAME) and so the domain check can name it. A request
   that arrives *as* it — opened directly, or from a CDN that rewrites the host
   — is refused: `TenantGuard` 404s every path on a reseller's platform
   subdomain (`surfaceTenantType`, no gate read), the door
   answers `serves: false` so the panel renders nothing, and `tenantOfHost`
   (files, branding, the bank callback) names no tenant.
3. **The reseller's CDN must keep the visitor's host.** The domain check's
   `http` / `https` lines pass only when the probe arrives as the domain itself,
   so a CDN set to send the target fails at setup, with the host it sent,
   rather than on every page later.
4. **Customers reach a reseller only on a domain of its own.** Until one is
   verified the reseller has no customer-facing address; its owner configures
   from the platform's panel.

## Consequences

- A CDN that forwards the CNAME target instead of the visitor's host no longer
  works; ADR-0060 (6)'s second case is withdrawn.
- The gateway's address is hidden only if `*.edge.<domain>` is a **proxied**
  record at the platform's own CDN. That is DNS configuration, not code:
  `tenant/contract.domains.md` "Setting up the CDN (ArvanCloud)".
- `panelHostOf` returns no host for a reseller without a verified domain, so a
  handoff to its panel is refused and a payer's return address is the
  platform's, as the callers already handle.
- The door rule no longer reads the onboarding gate: a reseller has no
  platform subdomain that could open, so every one is closed, including an old
  `<slug>.<domain>` row.
- No deleted host lingers in `tenant:host:<host>`, although the migration
  cannot reach Redis: the cached surface gained `tenantType`, so every entry
  from before the deploy fails the cache's shape check and re-reads, and an
  entry written since says `reseller`, which the rule closes.
