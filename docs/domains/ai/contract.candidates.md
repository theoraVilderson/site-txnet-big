---
id: ai
layer: domain
status: draft
version: 2
updated: 2026-10-02
---

# Contract — ai: candidates, the action types the engine proposes

The first step of the decision pipeline ([contract.md](contract.md) "The
decision pipeline"). Its own file because every action type that lands
(F-038-l, -m, -n, -o …) adds a row here.

## Rules

`decision/candidates.ts`, pure, from the stored predictions (F-038-d).
**One candidate per Grant at most**: a renewal, a resize and a top-up of one
Grant are one decision — sending two would be two messages about one service
(user, 2026-10-02, for the top-up). The deadline is the Grant's end or its
predicted run-out, whichever is first, and nothing is proposed more than 7
days (`SUGGEST_LEAD_DAYS`) before it. A type the tenant does not run is no
candidate.

| type | when | plan named | confidence |
|---|---|---|---|
| `resize_up` | `right_size` says up | the smallest public plan of the same product, mode and length holding factor × the bag (`quotas.traffic_bytes`), else the largest bigger one | `right_size`'s |
| `resize_down` (F-1514) | `right_size` says down (under 40 % in each of two periods) and the Grant ends inside 7 days — at renewal only | the smallest plan of the same product, mode and length, smaller than its own, holding the larger period's use × 1.25 (`RESIZE_DOWN_HEADROOM`) | `right_size`'s |
| `renew` | no resize to offer, the Grant ends inside 7 days, its plan has a price | its own plan | `renewal_probability`'s |
| `top_up_wallet` (F-038-k) | it would be `renew`, and a `wallet_need` names this Grant in the plan's own currency — the wallet holds less than its next two renewals. **Told instead of `renew`**; a resize is never displaced | its own plan — the renewal the top-up funds | `wallet_need`'s |

## What a candidate carries

- `reasons`: `suggest_variant` (Grant, `fromVariantId`, plan, price), the
  cost and `expected_margin`, `top_up_wallet`'s `suggest_top_up` (Grant,
  `amount`, `currencyCode` — the stored `wallet_need` value as a decimal
  string, C-02), then its prediction's.
- **Expected margin**: P(renewal) × (price − cost) of the plan named. A
  top-up is worth the renewal it funds, so it carries the margin `renew`
  would have — never the amount topped up, which is the user's money, not a sale.
- Template key `notifications.suggestion.<type>`; auth-service's template
  per type is the worker's `SUGGESTION_TEMPLATE_OF` (F-038-g3).

## Delivery and outcome per type

| type | delivery item (`POST …/due/take`) | told with | converts on (F-038-i) | panel card (F-038-h) |
|---|---|---|---|---|
| `renew` | `grantId`, `variantId`, `price` | `{{service}}`, `{{days}}`, `{{price}}` | a paid invoice for the plan, or the user's renewal of the Grant | yes |
| `resize_up` / `resize_down` | as `renew`, + `fromVariantId` | + `{{plan}}` | a paid invoice for the plan named | yes |
| `top_up_wallet` | as `renew`, + `amount {amount, currencyCode}`; the worker refuses one without it | + `{{amount}}` | a `payment_gateway` wallet credit | not yet: F-038-k1 |

## Planned

`trial_convert` (F-038-l, blocked on F-705): its rules are decided in
[open-questions.md](open-questions.md). `checkout_help`, `win_back`, a
reseller subject: F-038-m, -n, -o.
