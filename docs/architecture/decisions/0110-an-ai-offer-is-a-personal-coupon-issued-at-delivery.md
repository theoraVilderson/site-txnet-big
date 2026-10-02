---
id: adr-0110
status: accepted
updated: 2026-10-02
---

# ADR 0110 — an AI offer is a personal coupon, issued at delivery

- **Status:** accepted, not built (F-038-f1 … f3)
- **Date:** 2026-10-02. The user chose every point below in conversation,
  each the recommended option.
- **Affects units:** ai, billing, automation, panel-web
- **Builds on:** ADR-0109 point 9 (money rules), ADR-0048 (coupon ownership),
  F-038-i (outcomes)

## Context

ADR-0109 point 9 lets the engine give a discount only from an offer the
tenant defined (`ai.offer`: a coupon template or a variant, a maximum
discount, a daily budget), only where the predicted renewal without it is
under 0.5, once per account per offer, never to the holdout, and accepted
through the existing coupon path. It did not say how a discount reaches one
user, when the budget is spent, or what type such a suggestion is. Billing
has no "coupon template", and the engine writes no billing table (ai
invariant 7).

## Decision

1. **A personal coupon, cloned from the template.** An offer's
   `couponTemplateId` is one of the tenant's own coupons. At delivery,
   billing issues a new single-use `targeted` coupon for that user alone,
   cloned from the template — gateways, service scope, channels — with the
   discount the lower of the template's and the offer's
   `maxDiscountPercent`, expiring at the action's deadline. The code rides in
   the message and the card; the engine asks billing for it and writes only
   `ai.*`. Not chosen: adding the user to the template's allowed users — one
   shared code, no per-user expiry, and a list that grows without end.
2. **The daily budget is spent when a coupon is issued**, at the discount it
   would give on the plan's price, in the offer's currency. Issuing stops for
   the day at the budget, so what is redeemed can never exceed it. An unused
   coupon is not given back — its day has passed; the cost is only caution.
   Not chosen: counting redemptions — every coupon issued in a week may be
   redeemed on one day.
3. **A discounted renewal is its own type, `retain_offer`.** When
   `renewal_probability` is under 0.5 and the tenant has an active offer, the
   Grant's candidate is `retain_offer` instead of `renew` — still one per
   Grant. Its type switch, opt-out, cooldown and uplift row are its own, so a
   tenant sees whether discounts earn more than they give away, and a user or
   tenant can switch off discounts alone.
4. **Built in three rows:** F-038-f1 the offers (create, edit, list — what
   the AI page needs, so F-038-j waits on it alone); f2 the engine's choice
   (`retain_offer`, the guardrails, once per account per offer); f3 the
   coupon issued at delivery, the budget charged, the code told.

## Consequences

- A suggestion still moves no money (ADR-0109 point 9): billing writes the
  coupon, the user decides to use it.
- F-038-i measures `retain_offer` as its own arm: a coupon redeemed is a
  `paid` invoice for the plan named, like `renew`.
- F-038-q (one per account per offer in the database) builds on f2's
  service rule.
