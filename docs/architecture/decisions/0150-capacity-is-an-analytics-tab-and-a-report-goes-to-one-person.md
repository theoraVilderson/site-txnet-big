---
id: adr-0150
status: active
updated: 2026-10-16
---

# ADR 0150 — Capacity is an analytics tab; a scheduled report goes to one person

- **Status:** accepted
- **Date:** 2026-10-16
- **Decision:** the user's (2026-10-16, asked at the start of F-1005-a and
  F-1006-a; each answer the recommended one)
- **Affects units:** network (`panel_cost`), billing (the capacity rollup and
  tab), ai (its forecast rule, now shared), automation (report schedules),
  panel-web (`/analytics` Capacity and Reports)

## Context

F-1005-a was ingested into `ai` as "forecast a panel's traffic against its
capacity", but a panel had no traffic capacity anywhere — only `maxClients` —
and every figure the forecast needs (a panel's traffic per day, its price, its
sales and attributed cost) lives in billing's analytics rollup, which only
billing reads. F-1006-a's "report to bot or email" named no recipient, and the
notification path can send neither an email attachment nor a bot file.

## Decision

1. **A panel's capacity is its month's traffic and its users.** A price row
   (`network.panel_cost`) may carry `monthlyTrafficBytes` — a server is bought
   as "X TB a month for Y dollars", so the allowance is history beside the
   price it came with. Users are `panel.maxClients`. The sooner of the two
   full dates is the panel's.
2. **Capacity is billing's `capacity` analytics tab**, not an ai route: it
   gets the door (`analytics.read`), the cache, the export and the live
   re-read every tab has. The forecast is not a second one — the 7-day rule
   moved from ai into shared-core (`forecastSpanMs`) and both read it.
3. **A report schedule belongs to one person** — its creator, a holder of
   `analytics.read` — and goes only to their own bot chat and verified email.
   The key is checked again at every send; a person who lost it gets nothing.
4. **A report is a short text and a link**: the period's headline figures with
   their change, and a link to the tab and window on `/analytics`. The Excel
   file is a later row (an email attachment and a bot file are each a new path
   in notification).

## Rejected

- **Users only** (no migration): a VPN panel usually runs out of traffic before
  users, and the column would be added later anyway.
- **The allowance on `network.panel`**: one value with no history, so a change
  mid-month would restate the months before it.
- **Capacity inside ai**: a reader view onto every analytics table, a second
  door (`ai.manage`) on one page, and no export.
- **Every holder of `analytics.read`, or any address typed in**: figures sent
  to people who never asked, or outside the permission model entirely.

## Consequences

- Every tenant is rebuilt once (migration `20261016000700`) so a panel's
  traffic has its history.
- A reseller's own panels have no price today (network `contract.panel-cost.md`
  rule 4), so they show traffic and users and say "no cost set".
