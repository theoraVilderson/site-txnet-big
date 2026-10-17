---
id: panel-web
layer: interface
status: active
version: 25
updated: 2026-10-17
---

# Contract — panel-web / a product's cost in the catalog (F-1002-g, ADR-0151)

Where a tenant says what its products cost it, so the Profit tab stops
reading a product with no panel as 100% margin. Over catalog
[contract.cost.md](../../domains/catalog/contract.cost.md), through
`lib/catalog-cost-api.ts` on the surface's own prefix — the ambient
`/catalog` and a reseller's `/my-resellers/:id/catalog` alike.

## Rules

1. **A variant's cost per sale** (`VariantCostSection`, in each variant card,
   `VariantCard.tsx`): the cost in effect, or **"no cost set"** in the error
   tone — the line that explains a 100% margin; a new cost; its history. A
   cost is never edited: a new row replaces it from its day.
2. **From now, or from the 1st of this month** (`SegmentedControl`, `COST_FROM`):
   the two starts billing accepts — no earlier than this UTC month. The second
   costs this month's sales too; the hint says closed months never change.
3. **Usage costs** — a catalog tab (`MeterCostsTab`): one card per meter
   billing answers (never `vpn.traffic`, costed from its panels), the cost in
   effect as "{cost} per {size} {unit}", and a new one with its unit size —
   the first size by unit: 1,000 counts or tokens, 3,600 seconds.
4. **The form says billing's rules first** (`_lib/cost-form.ts`): a cost per
   sale 0 or more to the cent, a unit cost to 8 places, a unit size a whole
   number ≥ 1. A refusal is the catalog's (`useMessage`).
5. **0 is a cost** and shows as one; only no row is "no cost set".

## Proof

`catalog/cost.test.tsx`: the form's rules, the two starts, the cost in
effect; the section says "no cost set", writes one from the 1st of the month
and reads it back.
