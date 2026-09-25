---
id: adr-0087
status: active
updated: 2026-09-25
---

# ADR 0087 — a discount without a code is a billing rule

- **Status:** accepted
- **Date:** 2026-09-25
- **Affects units:** billing, catalog (read only), panel-web (later rows)
- **Decision row:** D-45 (the agent's recommendation, taken by the user)

## Context

The user reported on 2026-09-25 (F-114-h) that a tenant cannot give a
discount without a code: a percentage or a fixed amount on a product, a
category, a group or named users, inside a time window. The only discount
the platform had was a coupon, which the buyer must type.

The catalog already has a rule for campaigns (area 4.8): F-503 (time-boxed
campaign) and F-505 (seasonal pricing) never overwrite a `Price`. They add a
new price row with `effectiveFrom`, so yesterday's invoice keeps yesterday's
price. A price row is one price for every buyer of a variant. It cannot say
"these users" or "this category", and one price row per user or group would
multiply the price history with every tenant and group.

## Decision

1. **Two layers.** A campaign or a season that changes the price for
   everyone is catalog price rows (F-503-a, F-505-a). A discount that depends
   on who buys, or on what the product is filed under, is a
   `billing.discount_rule`, applied when an invoice is priced.
2. **A rule is one tenant's own**, the platform owner's included (strict
   RLS). No platform rule serves another tenant's users. That would be a
   reseller-margin question, and nothing asks it yet.
3. **What it covers:** everything, one product, or one category and every
   category under it. **Who it serves:** everyone, or its named users.
   **When:** `startsAt` to `endsAt` (exclusive; null = until switched off). A
   group target waits on a group model (F-114-j), and fits as one more
   "who" column.
4. **One rule, never a stack.** Of every rule that matches, the one that takes
   the most applies. A tie goes to the older rule, so pricing the same
   purchase twice gives the same answer. Two campaigns never add up to more
   than either meant.
5. **Before coupons.** Coupons are validated against what the rule left, so a
   coupon's minimum purchase and percentage read the discounted price. A rule
   that took the whole price leaves every code `nothing_to_discount`.
6. **The invoice records it:** `discountRuleId` and `ruleDiscount`, inside
   `discount`, so `total = amount - discount` holds unchanged. Editing a rule
   changes only invoices made afterwards. A rule an invoice names is
   switched off, never deleted (RESTRICT).
7. **The same admins as coupons.** The routes are behind `coupon.manage`
   and spend the coupon admin's rate budgets, and every write leaves an
   `admin_audit_log` row.

## Consequences

- Tiered volume discounts (F-504-a) become one more rule kind, once "volume"
  is decided.
- The shop's offer list still shows the catalog price. The invoice shows the
  rule's name and what it took (`automaticDiscount`). Showing it on the offer
  first is a panel row.
- Rows: F-114-h (table, pricing, admin routes), F-114-k (the panel page to
  manage rules), F-114-l (the shop shows the automatic discount).
