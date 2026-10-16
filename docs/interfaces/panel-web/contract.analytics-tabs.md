---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-16
---

# Contract — panel-web: `/analytics` tabs built after Resellers

A topic file of [contract.analytics.md](contract.analytics.md), opened because
that file was at its cap. The chart kit, its rules and the page hold here
unchanged; this file says what each later tab draws. The figures are
billing's ([contract.analytics-tabs.md](../../domains/billing/contract.analytics-tabs.md));
nothing here redefines one. Code: `(panel)/analytics/`.

## Profit (F-1001-m)

`ProfitTab`, over billing's `margin` (F-1001-l, ADR-0149), the tab `?tab=margin`
named "Profit", offered to every reader of `/analytics` (billing's door is
`analytics.read`, as every tab's).

1. **Tiles:** net, cost (down is good), margin, each with its `DeltaPill`;
   margin rate as a percent, a dash with no net.
2. **No cost set** (the platform's own view): an `Alert` names each panel in
   use with no monthly cost (`formatList`, the reader's conjunction) and links
   to `/systems`, where a panel's cost is set — a margin with no cost is not
   believed.
3. **Charts:** sales and cost as two series on one money axis (`TrendChart`,
   slots 1 and 2, legend); where the cost went (`BarList`: split by use, idle
   panels, unallocated). Each with its table view.
4. **Lists:** margin per product, per panel (only with a panel), the losing
   users (each by name, opening their user page — a workspace's own, as the
   Customers tab links) and, on the platform's own view, per reseller. A loss
   is a `Badge` with an icon and the word "Loss" beside the figure (rule 4); a
   row under 5 buyers reads "fewer than 5"; no user list where billing answers
   none.
5. **Live:** the platform's own view re-reads on any reseller's
   `billing.analytics.reseller_refreshed` too, as the Resellers tab does — its
   per-reseller block moves with every reseller's pass (`READS_EVERY_RESELLER`).
