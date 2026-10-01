---
id: adr-0106
status: accepted
updated: 2026-10-01
---

# ADR 0106 — a reseller is bounded by limits set at three levels

- **Status:** accepted (series F-019-m … F-019-s)
- **Date:** 2026-10-01 (user: three levels, only a new item refused; which
  limits first was left to the agent, "for the business and the long run")
- **Affects units:** tenant, billing, entitlement, panel-web
- **Answers:** F-118-ar (a reseller raising its users' metered cap with no
  platform ceiling)
- **Leaves alone:** `tenant.tenant_restriction` — in the schema since the
  first draft, read and written by no code, no rows on dev. Not reused: its
  value is JSON and its `scope` (soft/hard) is a choice this ADR does not make.
  Its removal is its own row, because removing it is a `DROP TABLE`

## Context

A reseller acts on the platform's shared things: its users' services sit on
the platform's panels, its admins issue services by hand at no price, and its
custom domains each cost a certificate. Nothing bounds any of it. F-118-ap
let a reseller give one user up to 1000 open metered services; the cap of
F-118-ao exists because a seat is held whether used or not.

The user asked for a limit wherever one is needed, settable for everyone and
for one or several resellers.

## Decision

1. **A limit is a key in one registry** (`shared-core`,
   `RESELLER_LIMITS`): its name, the platform's default in code, and its
   bounds. A new limit is a new key there plus the one place that enforces
   it; no table changes.

2. **Three levels, the most specific wins** (`resellerLimitOf`):
   1. the reseller's own (`tenant.reseller_limit`, with a reason and who set it);
   2. its package's (`tenant.package_limit`) — what a tier gets;
   3. the platform's (`tenant.reseller_limit_setting`), else the code default.

   "Several resellers" is one request naming several, written as one row
   each: a reseller's limit is still that reseller's, removable alone. A
   tier is a package, so changing what a tier gets is one row, not a row
   per reseller. At any level the value may be `null`: **no limit**,
   on purpose (a reseller the platform trusts), told apart from "not set
   here" by the row existing.

3. **Only a new item is refused** (user). Lowering a limit below what a
   reseller already holds takes nothing away: no service is suspended,
   no domain removed, no number rewritten. The next item past it is
   refused `reseller_limit_reached` with `{key, limit, used}`. A per-user
   number a reseller set above a lowered ceiling counts as the ceiling.

4. **The platform's own people are never bounded.** A limit binds a
   reseller's owner and staff (`ResellerAccess` admitted `owner`/`member`)
   and its users' purchases; the platform's staff acting on a reseller
   (`staff`) pass, as they pass a suspended reseller. The platform's own
   tenant has no limits.

   **A ceiling key binds everyone's writes** (`user_metered_cap_max`, F-019-n):
   it bounds the number *in effect*, so a number written above it would
   read as something it is not — such a write is refused even to the
   platform's staff, whose answer is to raise the ceiling itself (one row).

5. **The first four keys** — the ones that spend what the platform owns:

   | key | bounds | default | refused at |
   |---|---|---|---|
   | `user_metered_cap_max` | the number a reseller gives one user, and its tenant default (F-118-ap) | 20 | `GrantLimitsService` writes; the cap in effect is never above it |
   | `platform_open_grants_max` | open Grants of the reseller's users whose variant's group holds a platform panel (`onPlatformPanel`, as the wholesale leg) | 500 | invoice create and issue, and a reseller admin's issue |
   | `admin_issues_30d_max` | services a reseller's own people issue by hand, in any 30 days | 50 | a reseller admin's issue |
   | `custom_domains_max` | the reseller's custom domains (each a certificate) | 5 | adding a custom domain |

   The defaults are generous on purpose: none bites a reseller working
   normally, and each stops the case that would fill a panel or a
   certificate budget. Platform staff raise them per package or per reseller.

6. **Later keys use the same registry** and are rows of their own: end
   users, staff, bots, campaign sends per day, bulk job size, monthly
   traffic on platform panels.

## Consequences

- The platform owner sets every limit in one place (F-019-m API, F-019-r
  page); a reseller sees its own limits and what it has used (F-019-s), so
  a refusal is never a surprise.
- An end user buying past `platform_open_grants_max` is told the service is
  not available now — the reseller's limit is the reseller's business, not
  the buyer's.
- Each enforcing service reads the tenant schema's three tables through
  `resellerLimitOf`; a reseller's row is read in its own tenant scope (RLS),
  the platform's two tables have no tenant.
