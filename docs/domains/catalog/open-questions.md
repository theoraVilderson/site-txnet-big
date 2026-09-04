---
id: catalog
layer: domain
updated: 2026-09-04
---

# Open questions — catalog

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service. Is there a checkout/order concept, or does `billing.payment_transaction.` + `coupon_redemption.orderReferenceId` stand in for an order? | no | ASSUMED(2026-09-04): `orderReferenceId` is a synthetic order id, no order table yet | -> ADR |
| 2026-09-04 | `attributesJson` is unvalidated JSON. Per-category schema somewhere? | no | ASSUMED(2026-09-04): validated in the (unwritten) service per `category.key` | -> rules.md |
