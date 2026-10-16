---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-16
---

# Contract — billing / analytics: scheduled reports (F-1006-a)

A topic file of [contract.analytics.md](contract.analytics.md). Decided in
[ADR-0150](../../architecture/decisions/0150-capacity-is-an-analytics-tab-and-a-report-goes-to-one-person.md)
(3) and (4), and by the user on 2026-10-16: the schedules live beside the
tabs, behind the same door, so "who may be told the figures" has one answer.
Code: `billing-service/src/app/analytics/analytics-report*.ts`,
`analytics-reports.*`, `analytics-staff.ts`. The page is panel-web
[contract.analytics-tabs.md](../../interfaces/panel-web/contract.analytics-tabs.md) "Reports".

## Storage (migration `20261016000800_analytics_report_schedule`)

`analytics_report_schedule`: tenant (whose figures), user (the person, who
made it), `frequency` (`daily` / `weekly` / `monthly`), `weekday` (0 = Sunday,
weekly only — CHECK), `hour` 0–23 on the tenant's clock, `calendar` (`jalali` /
`gregorian`, the creator's page's), `tab` (the one its link opens), `bot`,
`email` (one at least — CHECK), `pausedAt`, `nextRunAt`, `lastSentAt`. Strict
RLS on the tenant; not derived, so a rebuild never touches it.

## Routes — `/api/billing/tenants/:tenantId/analytics/report-schedules`

All behind `ResellerAccess.for('analytics.read')`, the analytics read bucket.

| Operation | Input | Output | Errors |
|---|---|---|---|
| `GET` | — | `{schedules, reach}`: the caller's own, or every one for the tenant's owner — each with `paused`, `mine`, `name` (the person's, a label), `nextRunAt`, `lastSentAt`; `reach` `{bot, email}`: whether the caller has a verified chat and a verified address | 403, 404 |
| `POST` | `{frequency, weekday?, hour, calendar, tab, bot, email}` | the schedule | 400; 403 `not_allowed` (not one of the analytics staff); 409 `too_many_schedules` (10 a person) |
| `PATCH /:id` | any of the above, or `paused` | the schedule | 400; 403 (the owner may only pause or resume another's); 404 |
| `DELETE /:id` | — | `{removed: true}` | 404 — the person's, or the owner's |
| `POST /:id/send` | — | `{sent: true}` | 403 (not the caller's, or the caller no longer staff); 404; 409 `rebuilding` |

The tab is any analytics tab but `resellers`. A stored tab no longer offered
links to the Overview.

## Rules

1. **One person's** (ADR-0150 (3)): made by one of the tenant's analytics staff
   — `analyticsStaffOf`, every active holder of `analytics.read` (C-15) and
   the owner, the loss alert's recipients too — for themselves, and judged
   again at **every** send: a person who lost the key gets nothing, and their
   run moves on.
2. **The clock is the tenant's** (TZ-1, `analytics-report-clock.ts`): at
   `hour`, daily, on the weekday, or on the first day of the month in the
   schedule's calendar (a Jalali month for a Persian reader).
   `nextRunAt` is the first such instant **strictly after** the last, so a
   claim always moves it forward; a missed run is not caught up — the next
   send reports the latest closed period.
3. **The period is closed**: the days before the run's day — yesterday, the
   7 days before, or the month just ended in the calendar — compared with the
   one before it.
4. **What it says** (ADR-0150 (4), `analytics-report-figures.ts`): the
   Overview's net sales, orders, buyers and wallet top-ups, in the operating
   currency only (principle 6), each with its change, and a link to the tab
   and period on the person's own panel — `/analytics`, or `/reseller/analytics`
   for a reseller's owner (`panelUrlOf`; no host, no link). Read through
   `AnalyticsService.readTrusted` — the same builders and cache as the page,
   nothing hidden: the person is the tenant's own. A shape it does not expect
   is refused (zod), never sent.
5. **Sending** (`AnalyticsReportSender`): the worker's `analytics_report` job
   (every 15 minutes) calls `POST /api/internal/billing/analytics/reports/run`
   (`ServiceOnlyGuard`; answers `due`, `sent`, `skipped`, `failed`): up to 200
   due, oldest first, each alone — one failing is counted. A run is **claimed**
   on its `nextRunAt` in the same transaction as its event, so two runs never
   send it twice. While the rollup rebuilds, the run is left due.
6. **One event per send**, `billing.analytics.report` —
   `{tenantId, userId, scheduleId, channels, tab, link?, from, to, currencyCode,
   net, netDelta, topUps, topUpsDelta, orders, ordersDelta, buyers, buyersDelta}`,
   money as decimal strings, a change a ratio, `new`, or empty. worker-service
   tells it on exactly `channels` (automation `contract.notices.md`), and
   pushes `{type, scheduleId}` to the person's `user:` so the Reports tab
   re-reads (C-14). The words are auth-service's, in the person's language.
7. **"Send now"** is the same send without a claim: `nextRunAt` stays.
