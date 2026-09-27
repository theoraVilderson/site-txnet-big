---
id: adr-0095
status: active
updated: 2026-09-27
---

# ADR 0095 — the egress allowlist is the platform owner's alone

- **Status:** accepted
- **Date:** 2026-09-27
- **Affects units:** network (`contract.registration.md` rule 5, `network-service/internal/egress`)
- **Amends:** ADR-0080 decision 2
- **Decision row:** `network/open-questions.md` 2026-09-23; the user approved on 2026-09-27

## Context

The dial guard (F-027-dl) refuses every inward address a panel resolves to.
`PANEL_EGRESS_ALLOW_CIDRS` reopens private ranges the operator vouches for,
such as a router behind the platform VPN, and today it applies to **every**
panel. That is safe only because registration is owner-only (ADR-0080
decision 2). Once a reseller may register a panel, it could name an address
inside an allowed range, and the collector, holding the cross-tenant role,
would dial the owner's router for it.

## Decision

1. **The allowlist applies only to a platform-owned panel**: one whose
   `tenantId` is null (network invariant 9). A tenant's panel is dialed
   through the bare guard, whatever the environment says.
2. The choice is made where the guard is built for a dial, from the panel
   row, not in the driver. A driver never sees which guard it got.
3. A tenant that needs a private panel gets no per-tenant allowlist. If that
   need appears, it is its own decision, because a tenant's range can overlap
   the owner's.
4. This is a precondition for opening registration to resellers. It does not
   open registration: ADR-0080's revisit trigger still decides that.

## Consequences

- Positive: opening registration to resellers adds no path into the owner's
  network. The SSRF question becomes a permission change, as ADR-0080 wanted.
- Negative / accepted cost: a reseller with a panel on a private network
  cannot use it until decision 3 is revisited.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep one allowlist for all panels and check the range at registration | the address checked must be the address dialed (rule 1); a name can resolve elsewhere later |
| A per-tenant allowlist now | nobody has asked for it; ranges overlap across tenants and the owner, which needs its own design |

## Revisit trigger

A reseller asks to register a panel reachable only on a private network.
