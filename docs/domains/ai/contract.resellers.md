---
id: ai
layer: domain
status: draft
version: 2
updated: 2026-10-02
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

## Planned

- F-038-o2: the platform owner's route over these rows; F-038-o3 its panel page.
- F-038-o4: the upgrade, told to the reseller's **owner** only — the quota
  alerts' recipient (F-019-v8), so everything about the reseller's package has
  one recipient (user, 2026-10-02).
