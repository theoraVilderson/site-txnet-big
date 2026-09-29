---
id: adr-0104
status: accepted
updated: 2026-09-29
---

# ADR 0104 — platform staff see a reseller's people only with its consent

- **Status:** accepted
- **Date:** 2026-09-29 (user, D-57; series F-117)
- **Affects units:** tenant, identity, audit, notification, panel-web, billing
- **Amends:** ADR-0064 (2), ADR-0102 (2), ADR-0103 (2.3) — platform staff are
  no longer admitted to a reseller's people by `tenant.manage` alone
- **Spec:** `spec.py --section 3.7` (time-bound consent), `--section 3.6` layer 6

## Context

`ResellerAccess` admits the platform's staff holding `tenant.manage` to every
reseller, at any time, with nothing asked of the reseller (tenant invariant 21).
Through the users-admin routes (ADR-0102) that means every reseller's users,
their Grants and configs, and — per ADR-0103 — acts on their accounts. One
leaked staff credential reads every reseller's customers. The catalog (3.7)
already requires consent; the code never built it. Each new account act
(role assignment, password reset, session kill, impersonation) built on the
unlocked door makes the change more expensive.

Rejected: **standing access plus an audit trail** (audit tells the reseller
after the fact; it does not narrow what a stolen credential reads);
**consent for everything, statistics included** (the platform bills,
settles and sizes the network from those numbers — ADR-0067 — and a reseller
could blind its own supplier).

## Decision

1. **Machines always, people with consent.** Services (network, metering,
   billing, fraud detection) read a reseller's data as they do today. A human
   on the platform's staff reads or acts on a reseller's people only through
   one of the three tiers below.
2. **Tier A — the reseller as a business, no consent.** Configuration and
   status (domains, brand, gateways, catalog, suspension), what it owes, and
   **aggregates**: counts, sums, trends, per-product splits.
   The test: *can the figure be tied to one person?* If not, it is tier A.
3. **Small groups are suppressed.** A breakdown cell under 5 people is shown
   as "fewer than 5". Totals for the whole reseller are not suppressed.
4. **Tier B — support, with consent.** Anything that names a person: user
   lists, one user's Grants, configs, usage or purchases, a top-N with names,
   drilling from a figure into its rows, an export, impersonation. Admitted
   only under a live `SupportAccessConsent` that the reseller's owner (or a
   staff seat of it holding `tenant.manage`) grants **from its own panel**:
   - scope `read` or `act`; default 4 h, tenant-configurable, hard cap 24 h;
   - the platform may *request* one, never grant itself one;
   - revocable at any moment; revoking ends access on the next request.
5. **Tier C — emergency, without consent.** Abuse, legal order, security
   incident. A separate permission, a mandatory reason, 1 h hard cap, no
   extension without a new entry; the reseller is notified at entry, not
   later.
6. **Every act under B or C is recorded in the reseller's own history**
   (actor, tier, consent id, target, act) and the reseller can read it.
7. **The platform's own tenant is unchanged.** Its staff act on its users
   by permission, as today (ADR-0102 (2) stands for that tenant).
8. **Alerts carry no identity.** A fraud alert about a reseller's user shows
   staff the reseller and the signal, not the person; naming them is tier B
   or C.

## Consequences

- `ResellerAccess` gains a consent check on the person-data routes only;
  configuration routes (ADR-0064 (4) onboarding console) keep today's rule.
  Tenant invariant 21 changes when F-117-b ships.
- ADR-0103's rule still decides *which person* an admitted actor may act on;
  this ADR decides whether platform staff are admitted at all.
- Impersonation (F-006) of a reseller's user needs tier B `act` or tier C.
- Support becomes slower by one approval; tier C covers what cannot wait.
- Until F-117-b ships, the old door stays open; nothing new may be built on
  it that assumes standing access.
