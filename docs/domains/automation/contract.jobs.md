---
id: automation
layer: domain
status: active
version: 6
updated: 2026-10-03
---

# Contract — automation: the jobs

The §10 split of `contract.worker.md`, made when F-033-k's `support_auto_close`
met its 250-line cap. The runtime that ticks these is still there; this is
each job's row and the rules every job that crosses a service follows.

## The jobs (F-031-c)

| key | what it does | needs |
|---|---|---|
| `worker_heartbeat` | nothing, and records that it did — the proof the tick path is alive | — |
| `vault_credential_retention` | destroys superseded credential versions past their rotation grace window (ADR-0026 rule 4) | `TENANT_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `group_membership_end` (seeded `always_on`) | removes group memberships past their end and tells each person what they lost (GR-1-c, governance `contract.md`) — `POST /api/internal/user-groups/end-memberships` | `AUTH_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `key_window` (seeded `always_on`) | opens and closes keys given to one person for a window and tells each person what moved (F-030-a, identity `contract.access.md`) — `POST /api/internal/user-keys/windows` | `AUTH_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `deposit_pending_expiry` / `invoice_pending_expiry` | expires `pending` top-ups / unpaid invoices past their `expiresAt` and gives their coupon holds back (F-092-k `contract.deposit.md`; F-111-a `contract.purchase.md`, billing) | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `deposit_reconciliation` | asks the gateway about pending and expired top-ups nobody came back for, and about a verifying one only when its retry is 10 min overdue (the next job is not running): credits what it confirms, flags a differing amount (F-092-l; `domains/billing/contract.verify.md`) | the same two |
| `deposit_verify_retry` | asks again about verifying top-ups whose retry is due, every tick: credits, re-schedules silence, flags one still verifying after a day (F-092-y, F-092-ac) | the same two |
| `notification_campaign_fan_out` | writes recipient rows for started campaigns in resumable batches (F-035-d, `domains/notification/contract.md` "Sending") | `NOTIFICATION_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `notification_campaign_delivery` | sends claimed queued recipients through their tenant's Telegram/Bale bot; `stalled` rows are its errors (F-035-e, same contract, "Delivering") | the same two |
| `tenant_subscription_renewal` | renews due reseller subscriptions from their billing wallet, warns or suspends the unpaid; a platform tick, seeded `*/5`; `failed` renewals are its errors (F-019-c, `domains/tenant/contract.billing.md`) | `TENANT_API_BASE_URL` + `SERVICE_AUTH_TOKEN` (F-018-v) |
| `grant_config_purge` | releases the panel seats of suspended Grants past their `purgeAfterDays` — `desiredRemote = absent`, our rows never deleted (F-027-y, `domains/entitlement/contract.md`), then tells those a day from it (F-601-j), then closes those past the close window (F-118-x; a rolled-back close is a run error); a platform tick, seeded `20 * * * *` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `grant_bulk_job_drain` | acts on the next batch (`GRANT_BULK_JOB_BATCH_SIZE`) of every running bulk job a reseller's admin started by a filter — asks `grant-bulk-jobs/drain` (F-311-u2, `domains/billing/contract.reseller-grants-bulk.md` "By a filter"); `always_on`, a platform tick; a started job finishes whatever its tenant's status; the same call purges the per-Grant rows of jobs ended 30 days ago (F-311-u3) | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `config_move_job_drain` | moves the next batch (50) of every running config move job a reseller's admin started — asks `config-move-jobs/drain` (F-311-ad, `domains/network/contract.config-move.md`); `always_on`, a platform tick; resumable, an item's outcome commits with its move |
| `migration_run_drain` | takes one import run a reseller asked to preview, reads its source panel and writes the dry run's report, the next batch (200) of one it committed, the next batch (200) of one it is rolling back, and purges the snapshots of up to 10 runs whose window ended — asks `migration-runs/drain` (F-206, F-207, F-211, `domains/entitlement/contract.import.md`); `always_on`, a platform tick, its call allowed 5 minutes; the run is leased while read, so two ticks never take it |
| `grant_group_fulfilment` | places a config on every non-drain healthy member of a Grant's panel group and activates it at `minHealthyPanels` — asks `fulfil-due` (F-027-bl, `domains/network/contract.groups.md` rule 11), then `drain-due`: retires a drained member's configs after 2 × TTL and removes it (F-027-bm, rules 13-15); a platform tick, seeded `* * * * *` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `grant_delivery` | checks paid `pending` Grants whose `nextDeliveryAt` is due — delivered, retried at 1, 2, 4, 8, 16, 32 min, or cancelled and refunded in full — asks `deliver-due` (F-111-d, `domains/entitlement/contract.md`); the backstop since `entitlement.grant.created` delivers at once (F-114-i, `contract.outbox.md`); a platform tick, seeded `* * * * *` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `grant_unused_notice` / `grant_end_notice` / `grant_idle_notice` / `grant_exhaustion_forecast` | the retention clocks: ask `unused-due` — active Grants with nothing consumed 24 h / 72 h after activation emit "not connected yet?" (F-601-c) — and `end-due` — active Grants 7 / 3 / 1 day(s) before their end emit a time threshold, once per level per end (F-601-e), and held usage levels are told, alone after 24 h or with a time level (F-601-n) — and `idle-due` — a used Grant idle 7 days is checked in on once per stretch (F-601-l) — and `forecast-due` — a prepaid Grant whose last 72 h spend what is left within 5 days is told once per usage period (F-602); all in `domains/entitlement/contract.retention.md`; platform ticks, seeded `40 * * * *` / `50 * * * *` / `30 * * * *` / `45 * * * *` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `usage_capture` / `vpn_reserve` | expires every per-use token past its time (F-118-h), then captures every active postpaid meter's measured usage from its hold and tops the hold back to its target — asks `usage/capture-due` (F-118-g, `domains/billing/contract.usage-rating.md`), seeded `5 * * * *` / tops every metered VPN Grant's reserve hold to its target and releases one no longer planned — asks `traffic/reserve-due` (F-118-b, `domains/network/contract.reserve.md`), seeded `* * * * *`; platform ticks; a Grant or meter that threw is an error | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `retention_held_notice` | the end of quiet hours: takes the bot messages of retention notices held for their owner's quiet hours and now due (a 10 min lease), tells them on the bot only — one message per user and template, naming the services (F-601-p) — marked per ledger row, then `told` (F-601-m, `domains/notification/contract.retention.md`); a platform tick, seeded `*/5 * * * *`; a failed tell is an error, taken again after the lease | `NOTIFICATION_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `network_traffic_rollup` | rolls raw traffic into `traffic_daily_aggregate` and drops a raw month only once its aggregate matches it (F-027-o, `domains/network/contract.rollup.md`); a platform tick, seeded `15 3 * * *`; a refused drop fails the run | — (it calls `network.*` functions through its own pool) |
| `analytics_rollup` | asks billing `analytics/refresh`: today and yesterday of up to 200 tenants, stalest first, and a whole rebuild of one whose zone changed (F-1001-a, `domains/billing/contract.analytics.md`); a platform tick, seeded `*/5 * * * *`; answers `tenants`, `changed`, `rebuilt` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `analytics_loss_alert` | asks billing `analytics/loss-alerts`: each tenant's users whose 30-day cost passed their net by its percent, claimed once a tenant month and told to its staff (F-1003, `domains/billing/contract.analytics-tabs.md` "Loss alert"); a platform tick, seeded `30 5 * * *`; answers `tenants`, `told`, `failed` (its errors) | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `analytics_report` | asks billing `analytics/reports/run`: the scheduled reports due, each claimed on its next run, its person judged again, one `billing.analytics.report` each (F-1006-a, `domains/billing/contract.analytics-reports.md`); a platform tick, seeded `*/15 * * * *`; answers `due`, `sent`, `skipped`, `failed` (its errors) | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `automation_housekeeping` | deletes `bot_execution_log` rows past 30 days (failed/partial 90) per worker and **published** `outbox_event` rows past 7 days, 5,000 a statement, stopping a minute before the run timeout and counting what is left (hosting H14, ADR-0126 point 6); a platform tick, seeded `30 2 * * *` | — (`PrismaService`; `AUTOMATION_LOG_KEEP_DAYS`, `AUTOMATION_LOG_KEEP_FAILED_DAYS`, `OUTBOX_KEEP_DAYS`) |
| `tenant_domain_verification` | proves `verifying` custom domains and re-validates `verified` ones' TXT records; a platform tick, seeded `*/5`; a domain whose check threw is an error (F-018-i, `domains/tenant/contract.domains.md`) | `TENANT_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `reseller_quota_digest` | asks notification-service for each reseller's daily quota digest — yesterday's refused units and overage, from 09:00 on the quota clock, once a day; a platform tick, seeded hourly (`5 * * * *`) (F-019-v8, `domains/notification/contract.reseller-quota.md`) | `NOTIFICATION_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `ai_profile_rebuild`, `ai_suggestion_delivery` | rebuild: samples every active Grant's meters and rebuilds each account's AI profile, decisions and conversions — `ai-service`'s `profiles/rebuild` (F-038-c, F-038-e, F-038-i), seeded hourly (`5 * * * *`). Delivery: tells due AI suggestions, `*/5` — the order is notification `contract.retention.md` "An AI suggestion" (F-038-g3); a `retain_offer`'s coupon, a `checkout_help`'s other gateway, a `wheel_invite`'s may-they-spin from billing first (F-038-f3, F-038-m, F-038-u; billing contract.ai-delivery.md); a reseller's upgrade or billing-wallet top-up told to its owner, stopped `already_paid` / `plan_unavailable` before the floor (F-038-o4, F-1525-c; ai contract.resellers.md) | `AI_API_BASE_URL` (+ `NOTIFICATION_`, `BILLING_API_BASE_URL` for delivery) + `SERVICE_AUTH_TOKEN` |
| `catalog_season_write` | writes every tenant's season occurrences due within 14 days as campaign prices — billing `POST /api/internal/catalog/seasons/write-upcoming` (F-505-b; catalog contract.campaigns.md "Seasons"); hourly (`20 * * * *`); a refused one is the run's error | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `lottery_close` | freezes every published lottery past its `closesAt`: entrants judged and numbered, the list hashed, then the seed made and sealed (F-707-k); then draws every frozen one (F-707-l) and gives its prizes (F-707-m) — billing `POST /api/internal/billing/engagement/lotteries/close-due` (engagement contract.md "The close", "The draw", "The delivery"); every minute; a lottery that failed stays open or frozen, is the run's error | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `support_auto_close` | closes every support conversation waiting on its user (`pending_user`) or `resolved`, with no word from the user for the tenant's days (7 by default) — support `POST /api/internal/support/close-idle` (F-033-k; support contract.md "Auto-close, rating, reopen"); every 15 minutes (`*/15 * * * *`) | `SUPPORT_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `support_retention` | deletes attachment files 90 days after their conversation closed and archives, then drops, every support message month older than 12 months — support `POST /api/internal/support/retention` (F-033-n; support contract.operator.md "Retention"); daily (`30 3 * * *`); timeout `SUPPORT_RETENTION_TIMEOUT_MS` (10 min) |
| `guide_file_sweep` | deletes guide images and videos 7 days after upload that no published text or draft of any tenant names, at most 500 a run — tenant-service `POST /api/internal/guides/file-sweep` (F-414-m, ADR-0120; guide contract.md "Upkeep"); daily (`15 4 * * *`); an unreadable text sweeps nothing and fails the run |

The retention job is the first job that does real work, and what it settled is how a job reaches code it cannot import.

**A job calls another service over the internal seam.** The Credential Vault is
`tenant`'s code, its seams in `tenant-service` (F-018-ab); an Nx application cannot import another
Nx application. So the job asks over `POST /api/internal/vault/destroy-expired` behind `ServiceOnlyGuard` — the door
F-066-i built — rather than the vault moving into a workspace library, which
would drag its Prisma models, its KEK service and its audit trail across an app
boundary to serve one caller. `worker-service` therefore holds
`SERVICE_AUTH_TOKEN`, and holds no tenant credential of its own: it asks the
process that owns one to act, and never handles the value.

**Both variables are optional in `worker-service` and read per run.** A job whose seam is unconfigured fails its own
run into `bot_execution_log` and every other job keeps running; requiring them at boot would stop the consumer
draining the queue because one job's dependency is missing.

**Two jobs over one seam are still two jobs.** Expiry reads a clock and calls no gateway; reconciliation makes one call to a bank per payment.
They are separate keys with separate schedules and separate timeouts, because merging them would tie the cheap frequent one to the rate a bank will answer.

**A job registers itself; one that has to run schedules itself** (F-114-a).
`WorkerRegistryService` upserts a `bot_worker` row on boot; the publisher ticks
only `bot_schedule` rows. A job's `defaultSchedule` is written on boot,
`setByAdminId` null, **only while it has no schedule row at all** — an
operator's, or one switched off, stays theirs; an advisory lock makes two
replicas write one row. A job with none (`worker_heartbeat`,
`vault_credential_retention`) waits for an operator on `/auth/workers`
(F-031-b). Each default sits on its job class beside its reason. They were
`SEEDED_SCHEDULES` in `prisma/seed.js` until 2026-09-25: a job not yet
registered was skipped, and the seed failed outright from 2026-09-19, so no
job added that week was ever ticked — a paid Grant stayed `pending` for ever.

**An internal answer is enveloped.** `auth-service` and `billing-service` send
every route, `/api/internal/*` included, through shared-core's
`ResponseInterceptor`: `{ ok, msg, data }`. A job reads its counts from
`data` via `automation/internal-answer.ts` (`envelopeData`), never the top
level — until 2026-09-14 all three HTTP jobs did, and each failed its first
real run the moment it was scheduled.

**One token opens every internal door, and widens nothing.** `SERVICE_AUTH_TOKEN`
says which *process* is calling and never which user, so the expiry job reuses
the credential the retention job already holds rather than introducing a second
one. The guard behind it is `shared-core`'s `ServiceOnlyGuard` since F-092-k;
`auth-service`'s own class of that name is its security middleware's other half,
and `bot-service`'s is a third copy that should collapse into the shared one.

**A job never succeeds quietly.** An unreachable service, a guard's 404 and an
answer in a shape the job does not recognise are each indistinguishable from
"nothing was due" if the run reports zero items and success. Each one throws,
so the consumer records `failed` (invariant #3). This is the rule a sweep needs
most: it is the kind of job nobody looks at while it is working.
