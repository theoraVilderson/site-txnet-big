---
id: adr-0151
status: active
updated: 2026-10-17
---

# ADR 0151 — Every product has a cost: per sale, per unit of use, or what the platform charged

- **Status:** accepted
- **Date:** 2026-10-17
- **Decision:** the user's (2026-10-17: "the analytics must not break when I
  sell products that are not VPN"; the recommended option)
- **Affects units:** catalog (two cost tables and their routes), billing (the
  cost rollup, the margin read), panel-web (`/catalog`, the Profit tab)
- **Amends:** ADR-0149 (3) — a reseller's wholesale cost goes to the Grant it
  was charged for; billing `contract.analytics-tabs.md` "Cost attribution".

## Context

ADR-0148 (8) said cost and margin "attribute by meter where a cost exists and
say `no cost set` where none does". F-1002-b built the one cost source that
existed — a panel's monthly price, split by bytes. A seeded test on dev
(2026-10-17: dedicated IPs and API access sold beside VPN) showed what that
leaves: a product with no panel has cost 0 and reads as **100% margin**, with
no notice; and a reseller's payments to the platform are split by its VPN
bytes, so a wholesale charge for an API Grant lands on its VPN products.

Every `metered_usage_charge` already names a record that carries a `grantId`:
the Grant itself, a usage token (`usage_authorization`), a `quota_adjustment`,
a `grant_renewal` or a `grant_duration_change`.

## Decision

1. **Two costs a tenant writes for its own items** (catalog): a variant's
   **cost per sale** (`variant_cost`) and a meter's **cost per unit**
   (`meter_cost`: `unitSize` units for `unitCost`). Each in the tenant's
   pricing currency, as a price; a change is a new row from `effectiveFrom`,
   never an edit (as `price`, `panel_cost`). Converted into the sale's
   currency by ADR-0149 (1) like every cost.
2. **Own items only.** A reseller's cost of a platform product is what it
   pays the platform; the catalog already answers a platform item as not
   found to a reseller, so it cannot be priced twice.
3. **`vpn.traffic` takes no unit cost:** its cost is its panels'. A Grant the
   tenant pays the platform wholesale for (a wholesale leg) takes no unit
   cost of the tenant's own either — the wholesale charge is that cost.
4. **A wholesale charge is the cost of the Grant it names**, its product,
   user and panel; the bytes split stays only for a charge that names no
   Grant, and a subscription stays unallocated.
5. **No cost is said, not zeroed.** A product sold in the window with no cost
   row is `noCost`; the Profit tab says `no cost set` and lists them. A cost
   set to 0 is a cost, and is shown as one.

## Rejected

- **Only the `no cost set` notice** (cheaper): honest today, but the first
  real non-VPN product needs this built anyway, and its months before then
  would have no cost history to report.
- **A cost per product rather than per variant**: a 1,000-member order and a
  5,000-member one cost differently; the variant is what is sold.
- **A unit cost per product and meter**: one meter's use costs the tenant the
  same whatever product it was sold in; a per-product rate can be added as a
  row of its own if that ever stops being true.

## Consequences

- `AnalyticsCostKind` gains `sale` and `usage`; every tenant is rebuilt once.
- A reseller's per-product and per-user margin moves for VPN too: charges
  that were spread by bytes now sit on the Grant that caused them.
