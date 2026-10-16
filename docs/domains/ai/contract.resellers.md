---
id: ai
layer: domain
status: active
version: 2
updated: 2026-10-14
---

# Contract — ai: a reseller as the platform's customer

ADR-0109 point 4: the reseller is a customer of the platform, so the same
engine predicts its package-quota run-out and churn and suggests its upgrade.
Its own file because the series (F-038-o1 … o4, F-1525) is one subject kind
and [contract.md](contract.md) is at its cap.

## Where the rows live

A reseller is subject `tenant` with `subjectId` = its tenant id, in the
**platform owner's** tenant (data-model.md). Only the platform's run writes
them, and only when the platform's engine runs (F-1550: the platform is
entitled to every key; its own `ai.setting` can switch it off). Every reader
of a user's predictions (the decision run, the reseller's at-risk list) asks
for `subjectKind: 'user'`, so these rows reach none of them.

## How the platform reads its resellers (F-038-o1) — implemented

Through `txnet_ai_reader` only (invariant 7), in two scopes
(`profile/reseller-reader.ts`, `20261002001600_ai_reseller_inputs`):

| what | read how | why |
|---|---|---|
| the list: owner, subscription (period end, warned, grace, next package), the package's price for the period, the billing wallet | `ai.reader_reseller`, bound to the platform — the view answers **nothing** to any other bound tenant (user, 2026-10-02) | `tenant.tenant` has no RLS and the subscription and wallet are each reseller's; no cross-tenant pool for `ai-service` |
| each reseller's quota windows, per registry quota key and per platform product it sells | shared-core's read-only `quotaTermsOf` + `ResellerQuota.meterStatementOf`, `productQuotaStatementsOf`, bound to **that reseller** | the terms the quota engine applies (three levels, the period lock, the kinder part) — never re-derived here (billing contract.reseller-quota.md) |
| its usage: per meter, units of the last 7 days and the first row of the last 60; platform-product sales of the last 30 days and the 30 before | one `GROUP BY meter` over its live `reseller_quota_usage` rows, same scope | aggregates, not rows: a reseller selling thousands a day costs one query |

A reseller whose read fails is logged and left without a prediction that
hour; nothing is guessed. Each run replaces every reseller row of the two
kinds at once, so a reseller gone or no longer at risk keeps none.

## Predictions (F-038-o1, point 7) — implemented

`profile/reseller-predictions.ts`, pure. One row per kind per reseller, every
one with `reasons[]`.

| kind | `value` / `predictedAt` | rule | confidence |
|---|---|---|---|
| `quota_exhaustion` | days / the instant — of the **soonest** window at risk | every window with a limit (registry key, or a product's day / week / month): a full one is now (`quota_full`, with its overage and mode); else the last 7 days' rate (`QUOTA_RATE_WINDOW_MS`; a younger reseller's own history, at least 24 h) runs the remaining included units out **before the window ends** (`quota_rate`) — a later run-out is none, since the next window starts empty. Every window at risk is a reason, soonest first (≤ 20) | full 0.95; a rate 0.5 + 0.4 × (history ÷ 7 days) |
| `churn_risk` | 0–1 / the subscription's end | base 0.15 (`churn_base`); +0.30 the wallet holds less than the next renewal, in the price's currency, within 14 days of it (`wallet_short`); +0.20 renewal warned or in grace (`renewal_unpaid`); +0.20 platform-product sales of the last 30 days under half the 30 before, those at least 10 (`sales_fell`), or −0.10 above 1.2× (`sales_grew`); +0.10 a downgrade waits for the renewal (`downgrade_scheduled`); clamped 0.02–0.98. None without a subscription | 0.6 — rules, uncalibrated |

## Usage and the billing wallet (F-1525-a) — implemented

§24.3's hard rule holds: a forecast and a suggestion to a person, never a
meter changed or money moved. `profile/usage-forecast.ts`, pure.

| what | rule | where |
|---|---|---|
| a reseller's `wallet_need` | the billing wallet at its **wholesale** spend — `metered_usage_charge` debits less `metered_usage_refund` credits, the wallet's currency only (C-02), the last 7 days (a younger wallet over its own history, a day at least) per day; dated at the instant the balance reaches zero, kept only inside 30 days. `value` = the top-up that holds 30 days of that spend, rounded **up** to a whole unit (0 when it already does), with `currencyCode`; reason `wholesale_rate`. Confidence 0.5 + 0.4 × (history ÷ 7 days) | the platform's run, beside o1's kinds; read through `ai.reader_wholesale_spend` and `tenant_billing_wallet` in the reseller's own scope (`20261002001800`) |
| the rule | shared-core `forecastSpanMs` (`lib/ai/forecast-rate.ts`): every forecast here, and billing's capacity tab (F-1005-a, ADR-0150), reads its span through it — never a second rule | — |
| a tenant's own forecast | per meter, never summed across two: the last 7 days of `ai.meter_reading`, a day's mean over the history it has (24 h at least; dated from the tenant's first reading, since an idle hour writes no row) and 30 days of it — whole units, down, as decimal strings; and its own wallet as above | `GET …/usage-forecast` (contract.admin.md), `admin/usage-report.ts` |
| the platform's capacity | every tenant's hourly readings, each read in its own scope, summed per meter and hour, forecast as one; `tenantsMeasured` of `tenants` — readings exist only while a tenant's engine runs (F-1550), and the answer says how many it covers | `GET …/capacity`, platform owner only |

## The platform owner's list (F-038-o2) — implemented

`GET /api/ai/admin/resellers?kind=quota_exhaustion|churn_risk` (contract.admin.md;
`admin/reseller-forecast.ts`), behind `ai.manage`. Only a caller whose tenant
is the platform owner — any other is refused 403 `not_platform_owner`, never
answered with an empty list that would read as "no reseller at risk". The
panel shows it as the `/ai` page's resellers tab (F-038-o3, panel-web contract.ai.md rule 10), and the usage forecast and capacity as its usage tab (F-1525-b, rule 11).

| `kind` | order | each item |
|---|---|---|
| `quota_exhaustion` | soonest run-out first (a full window is the run's instant) | `tenantId`, `slug` (null for a reseller deleted since the run), `value` (days), `predictedAt`, `confidence`, `reasons` — every window at risk, the page words the codes |
| `churn_risk` | highest risk first | as above; `value` 0–1, `predictedAt` the subscription's end |
| `wallet_need` (F-1525-a) | soonest run-out first | as above; `value` the top-up with `currencyCode`, `predictedAt` the run-out |

## The upgrade (F-038-o4) — implemented

Told to the reseller's **owner** only — the quota alerts' recipient
(F-019-v8), so everything about the reseller's package has one recipient
(user, 2026-10-02). The owner is a user of the platform's own tenant
(ADR-0062), so nothing crosses a tenant: the action is the platform's.

| step | rule | code |
|---|---|---|
| when | the platform's run, after the predictions: a reseller whose `quota_exhaustion` falls inside 7 days (`SUGGEST_LEAD_DAYS`) | `decision/reseller-decision.ts` |
| the candidate | `resize_up`, subject `tenant`, about the soonest window at risk; deadline its end — a new window starts empty. Need = (used + rate × days left, or for a full window used + sold past it, at least included + 1) × 1.25 (`UPGRADE_HEADROOM`). The package: active, **pricier** for the reseller's period in the same currency (ADR-0107 point 9 — an upgrade applies at once; a cheaper one waits for the renewal and unlocks nothing now), and raising this quota — a registry key by its `package_limit` row (none = the platform's number, the same on every package), a product by its listing's window column (not listed = not sold). The cheapest that holds the need, else the biggest step up. None for a key the platform's staff set for this reseller alone (`reseller_limit`): no package moves it. Margin P × (new − current price): the platform's own sale, no cost | `decision/reseller-candidates.ts` |
| the steps | ADR-0109 point 8's, unchanged (`DecisionPipeline.decideAmong`): threshold, opt-out, cooldown and holdout of the **reseller**; quiet-down reads nothing; budget per subject; timed by the **owner's** active hours and quiet window | `decision/pipeline.ts` |
| the take | the item's `reseller` is read **now**, never at the decision: the owner, the reseller's current package, the named package's name, status and price for the period today, a product's name key (contract.candidates.md "Delivery") | `decision/delivery.ts` |
| the worker | claims it for the owner with no Grant; stops `already_paid` when the reseller moved off the package the engine saw, `plan_unavailable` for a package gone or unpriced — both before the floor; else `suggestionPackageUpgrade` to inbox and bot, the quota named as a quota alert names it | worker `ai-suggestion-delivery.job.ts`, auth-service `user-notifier.ts` |
| the tap | the owner's "don't show this again" opts the **reseller** out (invariant 14) | `decision/opt-out.ts` |

**The top-up (F-1525-c).** The same run proposes `top_up_wallet` beside the
upgrade for a reseller whose `wallet_need` run-out is ahead and inside 7 days
(`resellerTopUpCandidate`): the amount as `suggest_top_up` (C-02), deadline
the run-out, no margin — help with the reseller's own money, ranked as zero,
so an upgrade the same run wins. The take adds the wallet's balance now; the
worker stops it `already_paid` when the balance grew since the decision,
else tells `suggestionResellerTopUp` ({{amount}}, {{days}}) to the owner. A
suggestion only: nothing is charged (§24.3).

**Measured (F-038-o5, point 13).** The platform's hourly run, after its
reseller decisions, records conversions as a user's are (`OutcomeRun.recordResellers`,
`matchResellerOutcome`): between the decision and 7 days after the send, an
upgrade converts on the reseller's **upgrade charge** while it is **now on the
package named** (the charge does not name one), a top-up on a **billing-wallet
top-up** — read in the reseller's own scope through `ai.reader_billing_event`
(`20261002002300`: those two reasons, 60 days, no reference), worth the
charge's own amount. `POST /api/ai/admin/reports/uplift` with
`subjects: "resellers"` is the platform owner's report over them, against its
holdout of resellers (anyone else 403).
