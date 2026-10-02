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
**One candidate per Grant at most** (and one `checkout_help`, about no Grant; a `usage_alert` is help beside its Grant's sale, F-1516): a renewal, a resize and a top-up of one
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
| `retain_offer` (F-038-f2, ADR-0110) | it would be `renew`, `renewal_probability`'s value is under 0.5 (`RETAIN_OFFER_BELOW`), and an active `retain_offer` offer applies that this account was never given. **Told instead of `renew`, ahead of a top-up**; a resize is never displaced. An offer applies when the plan's price is in the offer's currency and — a variant offer — the Grant is on that variant; the discount is the lower of the offer's `maxDiscountPercent` and the template's own (percentage with its money cap, or fixed amount), in the plan's currency only, rounded down to the cent. Of several, the smallest discount | its own plan | `renewal_probability`'s. Margin: P(renewal) × (price − discount − cost) |
| `checkout_help` (F-038-m, ADR-0109 point 9) | the latest `failed` or `expired` gateway payment (`billing.payment_transaction`) of the last 48 h, 30 min old at least (`CHECKOUT_HELP_WAIT_MS` — time to retry alone), no `success` since; deadline 48 h after it (`CHECKOUT_HELP_DEADLINE_MS`). About no Grant — beside the Grants' candidates, never instead of one. Passes a failed payment's quiet-down (invariant 15) | none — billing names another gateway at delivery | fixed 0.7: the attempt is a fact. Margin `0.00` in the payment's currency (`help_not_sale`): help never outranks a sale |
| `usage_alert` (F-1516, ADR-0109 points 3, 6) | a `usage_spike` (contract.md "Predictions v1") whose `predictedAt` — 24 h after the window it measured — is ahead; that is its deadline. Beside the Grant's sale, never instead: help, like `checkout_help`. Meters only | none | the prediction's (0.75 on 14 usual days, 0.65 on 7–13). **No margin** (`help_not_sale`, no currency, C-02): ranked as zero, so a sale about the same Grant wins the run |
| `resize_up`, subject `tenant` (F-038-o4) | a reseller's `quota_exhaustion` inside 7 days: [contract.resellers.md](contract.resellers.md) "The upgrade" — a package, not a plan; the only candidate of its subject | the cheapest pricier package holding the window's projected use × 1.25 | the prediction's. Margin: that × (new price − current) |
| `top_up_wallet`, subject `tenant` (F-1525-c) | a reseller's `wallet_need` whose run-out is ahead and inside 7 days, with something to top up: [contract.resellers.md](contract.resellers.md) | none | the prediction's. **No margin**: the reseller's own money — ranked as zero, so an upgrade the same run wins |
| `win_back` (F-038-n) | a `win_back_window` (no active Grant) whose window — 14, 30 or 60 days since the last Grant ended — closes within 1 day (`WIN_BACK_LEAD_DAYS`), never a week early; the close is the deadline, so a window is told once (the 14-day cooldown is shorter than any gap between closes) | the last-ended Grant's own plan, priced — the prediction names the Grant first in its reasons | the prediction's (0.55; 0.65 signed in since). Margin: that × (price − cost), as no renewal is predicted |

## What a candidate carries

- `reasons`: `suggest_variant` (Grant, `fromVariantId`, plan, price), the
  cost and `expected_margin`, `top_up_wallet`'s `suggest_top_up` (Grant,
  `amount`, `currencyCode` — the stored `wallet_need` value as a decimal
  string, C-02), `retain_offer`'s `suggest_offer` (Grant, `offerId`,
  `discountPercent`, `discount`, `currencyCode`), then its prediction's.
- `offerId` on the action (`retain_offer`): the offer guardrail's and F-038-i's key.
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
| `retain_offer` | as `renew`, + `offer {offerId, discountPercent, discount {amount, currencyCode}}` from `suggest_offer` — `take` adds the offer's terms (template, cap, budget, author); the worker has billing issue the coupon before the floor, and refuses one without them | + `{{code}}`, `{{discount}}`; `{{price}}` after it — billing's coupon (F-038-f3, billing contract.coupon.md) | as `renew` | no |
| `checkout_help` | no Grant, no plan; `payment {paymentId, amount}` from `checkout_attempt`. Claimed with no Grant (F-038-g5); billing's `deposit/other-gateway` names the gateway — `paid` → `stop` `already_paid`, none → `stop` `no_other_gateway` (billing contract.ai-delivery.md) | `{{amount}}`, `{{gateway}}` | a `payment_gateway` wallet credit | no |
| `usage_alert` | `grantId` and `usage {meterKey, lastDayBytes, usualDayBytes, factor}` from `usage_spike`; no plan or price. The worker names the service only (billing `grants/names`, no `variantIds`) and refuses one without `usage` | `{{service}}`, `{{used}}`, `{{usual}}` (shared-core `remainingLabel`), `{{times}}` (the factor, whole) | never — it sells nothing | no |
| `resize_up`, subject `tenant` | `reseller {recipientUserId, currentPackageId, fromPackageId, packageId, packageName, packageActive, price, meter, period, included, used, newIncluded, productNameKey}` read at the take; no Grant | `suggestionPackageUpgrade`: `{{quota}}`, `{{used}}`, `{{included}}`, `{{package}}`, `{{newIncluded}}`, `{{price}}` | not yet: F-038-o5 | no |
| `top_up_wallet`, subject `tenant` | `amount` from `suggest_top_up`; `reseller` with `balanceThen` (`wholesale_rate`) and `balanceNow` read at the take; a wallet grown since stops `already_paid` | `suggestionResellerTopUp`: `{{amount}}`, `{{days}}` | not yet: F-038-o5 | no |
| `win_back` | as `renew` — the ended Grant, its plan; a plan no longer sold stops at the worker (`plan_unavailable`) | `{{service}}`, `{{plan}}`, `{{price}}` (no `{{days}}`) | a paid invoice for the plan | no |

## Planned

`trial_convert` (F-038-l, blocked on F-705): its rules are decided in
[open-questions.md](open-questions.md). 
