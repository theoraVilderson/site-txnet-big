---
id: catalog
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — catalog

**DRAFT** — from schema; not enforced in code.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | All plan/promotion amounts are base currency `Decimal` (ADR-0002) | schema | price drift |
| 2 | `pricePerUnit` is set iff `billingModel = pay_as_you_go` | planned service validation | nonsensical pricing |
| 3 | `category.key` is unique and stable — it is referenced by string elsewhere | schema `@unique` | dangling references |
| 4 | Only one active promotion per plan applies at a time (latest overlapping window) | planned service layer | stacked discounts |

## How to test

To be written with the service.
