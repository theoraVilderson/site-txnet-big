---
id: notification
layer: domain
status: active
version: 12
updated: 2026-10-01
---

# Contract — notification / a reseller told about its quotas

A topic file of [contract.md](contract.md), opened because that file is at its
250-line cap. What a reseller's owner is told about the quotas its package
sells (F-019-v8, ADR-0107 point 11). What a quota *is* and how it is consumed:
billing [contract.reseller-quota.md](../billing/contract.reseller-quota.md).
The buyer a quota refuses hears only "not available now" (F-019-v11).

Code: `shared-core/src/lib/billing/quota-alerts.ts` (the decisions),
`notification-service/src/app/quota/` (the digest route, the refusal sink),
`worker-service` `reseller-quota-digest.job.ts` and
`TenantSubscriptionNoticeConsumer` (`quotaNotice`), auth-service
`user-notifier.ts` (the words). Proof: `quota-alerts.spec.ts`.

## What is told, and when

| Notice | When | Template |
|---|---|---|
| 80% | the act whose included units cross 80% of a window | `resellerQuotaNearing` |
| 100%, overage | the act that fills a window, or the first sold past it, on `overage` | `resellerQuotaOverageStarted` (with the unit price) |
| 100%, stop | the same on `stop`, or the first act a `stop` refuses | `resellerQuotaStopped` |
| stopped | an overage the wallet could not pay (`wallet_empty`, `price_unavailable`) / the reseller's own cap (`spend_cap`) | `resellerQuotaUnpaid` / `resellerQuotaCapReached` |
| digest | yesterday on the quota clock had refused units or overage; told from 09:00 | `resellerQuotaDigest` `{refused, overageUnits, overageCost}` |

All go to the reseller's `ownerUserId`, panel inbox and linked bots, in their
language (user, 2026-10-01). Stop, unpaid and cap are `critical`; the rest
`important` (`notice-classes.ts`).

## Rules

| Rule | Why |
|---|---|
| **Once.** Each notice is a `reseller_quota_alert` row keyed (tenant, meter, window, period start, level), written with its outbox event; a duplicate is skipped and tells nothing. The digest is meter `*`, level `digest` | an act per second must not become a message per second |
| A window with no limit never alerts. Jumping from under 80% to full tells 100% only. Several windows (a product's day / week / month) are told each on its own | the number in the notice is the window's own |
| **80% and 100% commit with the act**: `consumeMeter` writes them in the caller's transaction, after the usage row | a rolled-back act tells nothing |
| **A refusal is recorded on a connection of its own.** The engine reports every `ResellerQuotaExhausted` — at `consume` and at `admit` — to a sink each consuming service registers (`QuotaRefusalSink`, cross-tenant pool): `reseller_quota_refusal` += the act's units for its day, then the stopped / 100% notice. Never awaited; a failure is logged and never reaches the act | the act's transaction rolls back; a lost record costs a digest line, not a sale |
| **The digest** is `POST /api/internal/notifications/reseller-quota/digest` (`ServiceOnlyGuard`, no body) -> `{resellers, told}`, called by the hourly `reseller_quota_digest` job: nothing before 09:00 on `quotaTimeZone`, each reseller once a day after it, nobody with neither refusals nor overage. Overage is live (unreleased) rows created that day, its cost per currency | one clock for the quota and its summary (ADR-0107 point 7) |
| A quota is named in the owner's language: a registry key by `notifications.resellerQuotaKeys.<key>`, a product's sales by its catalog name key (`productNameKey`); else `resellerQuota.unnamed` | a key name is not a sentence |

## Adding a quota

A new registry key (tickets, AI) alerts with no code: it needs one line in
`resellerQuotaKeys` in each language's `notifications.json`.
