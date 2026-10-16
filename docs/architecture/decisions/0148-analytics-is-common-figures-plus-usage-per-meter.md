---
id: adr-0148
status: active
updated: 2026-10-16
---

# ADR 0148 — Analytics is common figures for every product, plus usage per meter

- **Status:** accepted
- **Date:** 2026-10-16
- **Decision:** the user's (2026-10-16: the platform will sell products that are
  not VPN, and so may resellers; each may need its own figures)
- **Affects units:** billing (the rollup and its reads), panel-web (`/analytics`)
- **Amends:** billing `contract.analytics.md` — `analytics_stock_day.bytesUsed`
  and the panel filter stop being figures every product has.

## Context

The rollup (F-1001-a) and the Overview (F-1001-d) were built as if every
product were VPN access: a "traffic used" KPI, a panel filter, panels as a
breakdown. The catalog already sells other kinds — dev holds `feature_access`
and `external_order` products beside `network_access` — and the user expects
more, for the platform and later for resellers. A product with no panel and no
traffic then shows a meaningless tile, and its own measure (uses, seconds,
tokens) has nowhere to go.

The platform already has the general shape: `catalog.meter` names every
measured thing (`vpn.traffic` in bytes, `vpn.config.regenerate` in counts, …)
with its unit, its translated name and the service that reports it, and
`billing.usage_event` holds each tenant's use of each meter, written by any
service.

## Decision

1. **Two layers.** *Common figures* — net, gross, refunds, top-ups, orders,
   buyers, renewal, active services — are answered for every product of every
   kind, as today. *Usage* is answered **per meter**, never per kind: a product
   that declares a meter gets that meter's usage, with no analytics code.
2. **One usage rollup**, `analytics_meter_day` (flow): tenant · day · product ·
   meter -> `quantity` (the meter's unit) and `grants`. Read from
   `billing.usage_event`, except `vpn.traffic`, which keeps coming from
   `network.traffic_daily_aggregate` (it covers package Grants too) and is
   never also counted from usage events.
3. **The product's kind is a dimension**, not a figure: `fulfilmentKind` is
   fixed when a product is created, so reads join `catalog.product` for the
   `fulfilment` filter and the kinds an answer lists. No rebuild is needed for it.
4. **Panels are a VPN dimension.** The panel filter and the per-panel lists are
   drawn only when the window has a product with a panel; nothing else assumes
   one.
5. **The page follows the data.** Common cards always; one usage card (and KPI
   tile) per meter present in the window, named by the meter's `nameKey` and
   written in its unit (bytes, count, seconds, tokens). A meter added tomorrow
   draws itself.
6. **Resellers get the same rules.** Scope is unchanged (contract principle
   4): a reseller's answers hold only its own products and meters, so a
   platform-only product or meter never reaches a reseller's figures, and a
   reseller selling a non-VPN product later needs nothing new here.
7. **Expand, move, contract (C-39).** `analytics_stock_day.bytesUsed` stays
   while its readers move to `vpn.traffic` meter rows (F-1001-n, F-1001-o); its
   removal is a row of its own.
8. Later tabs build on this: capacity stays per panel (a VPN tab); cost and
   margin (F-1002, F-1001-l) attribute by meter where a cost exists and say
   `no cost set` where none does.

## Rejected

- **Cards per product kind** (a "VPN section", a "feature section"): every new
  kind would need page and rollup code, and two products of one kind can bill
  different meters.
- **Hiding the traffic tile when no VPN product is sold**: cheap today, but the
  next kind still has nowhere to put its own measure, and the tabs not yet
  built (capacity, profit, cohorts) would be written on the VPN assumption and
  rebuilt later.

## Consequences

- Two rows ahead of the remaining tabs: **F-1001-n** (billing: the meter rollup,
  the kind dimension, the reads) and **F-1001-o** (panel-web: the Overview by
  meter, the kind filter, panels only where they exist). F-1001-e waits for
  F-1001-o; F-1001-l for F-1001-n.
- The export needs nothing: a usage block is exported by its shape (F-1007-a).
