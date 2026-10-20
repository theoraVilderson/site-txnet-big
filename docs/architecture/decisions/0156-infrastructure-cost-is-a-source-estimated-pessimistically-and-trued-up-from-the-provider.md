---
id: adr-0156
status: active
updated: 2026-10-20
---

# ADR 0156 — Infrastructure cost is a cost source, estimated pessimistically and trued up from what the provider actually took

- **Status:** accepted
- **Date:** 2026-10-20
- **Decision:** the user's (2026-10-20), from real cases: an ArvanCloud CDN with
  50 GB free a month on an unknown reset day, then 1,800 toman a GB; behind it a
  pay-as-you-go server at 32,000 toman a day with 200 GB of free *download* on
  an unknown reset day, then 950 a GB; one Arvan account paying for platform
  servers **and** a personal server. Both providers are prepaid credit the owner
  tops up by hand; Arvan's panel shows each resource's cost.
- **Affects units:** billing (systems, analytics rollup, ledger), network
  (`panel_cost` retired), panel-web (the cost-source form)
- **Spec:** [billing/contract.cost-sources.md](../../domains/billing/contract.cost-sources.md).
  Builds on ADR-0155, ADR-0149, ADR-0151, ADR-0153.

## Context

`network.panel_cost` holds one `monthlyCostUsd` per panel, split daily by bytes
(`attributePanelCosts`). It cannot say: a CDN in front of one or many servers;
a daily fee; a free allowance, on which meter, resetting when; a price per GB
that differs by direction; a currency other than USD; a server that is the
owner's own and not the platform's. So free gigabytes are costed, and a shared
account's bill cannot be split. Guessing the provider's arithmetic exactly is
impossible: the reset day is unknown, and the provider counts bytes at its own
network card, not as our panel counts a user's upload and download.

## Decision

1. **A cost source replaces the panel's cost.** `CostSource`: kind
   (`server` / `cdn` / `other`), **purpose** (`platform` / `overhead` /
   `personal`), currency, GB size (default `METERED_RATE_UNIT_BYTES`, 1000³ per
   source when the provider bills so), the panels whose traffic passes through
   it (many-to-many, none for `overhead`/`personal`), the money account that
   funds it (dated), and for `personal` the party (ADR-0155 point 8). A byte a
   user moves costs **every** source of its panel: CDN and server both.
2. **Its price is dated history** (`CostSourcePrice`, `effectiveFrom`, never
   edited): a fixed amount per hour, day or month; a free allowance in bytes on
   a meter (`in`, `out` or `total`) with a reset (an anchor date and a period
   in days, or **unknown**); a price per GB for `in` and for `out` (0 = free);
   whether its input tax is deductible.
3. **Provider meters come from user bytes by a per-source map**
   (`meterMap`: `in = a·up + b·down`, `out = c·up + d·down`), default 1 for
   every coefficient: a relay, server or CDN, receives and sends each byte a
   user moves. The true-up ratio (point 6) says when a map is wrong.
4. **Between two truths the estimate is pessimistic.** A pure function walks
   the days in order: the fixed amount for the day, plus bytes past the
   allowance times the day's price. **An unknown reset means no allowance.**
   Withdrawable can therefore read low, never high.
5. **Allocation**: each day, a source's variable cost is split over the users
   of its panels by the bytes on its meter, its fixed cost by total bytes
   (`splitWhole`, ADR-0153); a day with no traffic is `idle` on the source.
   Reseller-owned panels are costed the same way, in the reseller's books.
6. **The truth is what the provider took.** A provider's prepaid credit is a
   money account. A top-up records the amount **and the balance just before
   it**; the drop since the last top-up is the actual cost of the interval,
   split over the account's sources in this order: an amount the owner enters
   per source (Arvan shows it); a source whose price is fixed only takes its
   exact fixed cost; a single source left takes the remainder; two or more left
   share it by their estimate, labelled "estimated split". Entered amounts that
   do not sum to the drop leave "unregistered usage", which must be assigned to
   a source or to overhead before the top-up saves. A postpaid invoice is
   recorded per source (`ProviderCharge`) instead.
7. **The true-up is its own line.** Estimate minus actual per source per
   interval posts as `infra_estimate_adjust` on the top-up day and is written
   to `analytics_cost_day` as kind `estimate_adjust`, split over the interval's
   users by their share of that source's estimate — closed days are never
   restated. The money view shows each source's actual-to-estimate ratio, its
   estimated credit left and the days until it runs out.
8. **Purpose decides where cost lands**: `platform` → infrastructure cost (the
   margin), `overhead` → overhead, `personal` → that party's draws — never the
   platform's cost, and withdrawable is not lowered twice (the top-up already
   moved that cash).
9. Existing `panel_cost` rows become platform sources with a fixed monthly
   price, one panel each, unfunded until the owner names the account;
   `panel_cost` is dropped once nothing reads it.

## Consequences

- Free allowances become profit when the provider's own number proves them,
  not before.
- The owner's only routine input is at a top-up the owner already makes by
  hand: the balance before it and, optionally, each source's amount.
- A provider API, where one exists, can fill the same record later (F-1008-s);
  nothing in this design depends on it.
