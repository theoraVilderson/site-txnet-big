---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-28
---

# Contract — billing / a reseller's admin on many users' Grants at once

A §10 split of [contract.reseller-grants.md](contract.reseller-grants.md), which
was at its ceiling. One request acts on up to 50 of a reseller's Grants, across
its users — e.g. +3 days to everyone after an outage (F-311-u, spec F-311). Each
act is the single-Grant route's own function, audit row (F-311-r) and notice to
the user (F-311-s), unchanged; the entitlement rules are entitlement's
[contract.admin.md](../entitlement/contract.admin.md).

## The route (built — F-311-u)

`POST /api/billing/tenants/:tenantId/grants/bulk`, `payment/gift/reseller-grants-bulk.controller.ts`
over `ResellerUserGrantsService.bulk` -> `actOnEach` (`reseller-grants-bulk.ts`);
body `grant-bulk.schema.ts`.

| `action` | Its own input (the single route's bounds) | `result` of an `ok` Grant |
|---|---|---|
| `freeze` | `until?` (ISO instant with offset) | `{frozenUntil, configsDisabled}` |
| `unfreeze` | — | `{endsAt, configsRestored}` |
| `days` | `days`, whole ±1..3650 — **relative only**, no `endsAt` | `{changeId, endsAtBefore, endsAtAfter, revived}` |
| `traffic` | `gb`, ±GiB, never 0, \|gb\| ≤ 100 000 | `{adjustmentId, purchasedBytesBefore, purchasedBytesAfter, usedBytes, spent, revived}` |
| `traffic_reset` | — | as `traffic`, plus `resetBytes` |
| `traffic_gift` | `gb` > 0, ≤ 100 000 (metered Grants) | as `traffic`, without `spent` |
| `speed` | `mbps` 1..100 000 or `null` | `{rateMbpsBefore, rateMbpsAfter}` |
| `devices` | `limit` 1..1000 or `null` | `{adjustmentId, limitBefore, limitAfter, panelsNotEnforcing}` |

Every body is `{requestId, action, grantIds[1..50], reason, …}`; `requestId` (a
uuid the consumer mints once per confirm) and `reason` (1..500) are
**required** for every action, freeze and unfreeze included. Bytes are decimal
strings, dates ISO. Answers **200** `{action, results[{grantId, userId, ok: true,
result} | {grantId, ok: false, reason, panels?}]}`.

| Rule | Why |
|---|---|
| Door `ResellerAccess` **`staffWrite`**, once, before any Grant is read; its refusals as every reseller route's (`resellerRefusal`: 403 / 404 / 409) | a suspended reseller reads its users' services but changes none |
| **A Grant must be the reseller's** (C-15): read by id *and* the path's `tenantId` in the act's own transaction; another tenant's Grant, or none, is `grant_not_found` and is not acted on | no path user to check; `grant` is RLS-strict but not in `TENANT_SCOPED_MODELS`, so the query says it |
| One transaction per Grant, ids deduplicated, in the order named; a refusal is that Grant's `reason` — the single route's (`grant_not_active`, `grant_closed`, `traffic_not_adjustable`, …; `rate_limit_unsupported` with `panels`) — and any other throw is `failed`, logged; the rest still run | one frozen or closed Grant must not stop 49 others; a Grant named twice gets +3 days once |
| Each Grant is one `admin_audit_log` row (the single route's `action`) and one notice to its user, in its transaction | the Grant's history and the user's message read the same as for one Grant |
| **One `requestId`, one act per Grant** (F-311-u1): each Grant's outcome is kept in `billing.grant_bulk_outcome` under `(tenantId, requestId, grantId)` — an `ok` one in the act's transaction, a refusal after it. A repeat answers the stored outcomes, **200**, identical, and acts on none of those Grants again; a concurrent repeat collides on the key and its act rolls back | a double click or a bot callback delivered twice must not turn +3 days into +6 |
| `failed` is **not** kept: a repeat tries that Grant again, and only it | nothing was done to it; a transient throw must not lock the request's retry |
| The same `requestId` with another body (action, input, reason, or selection — duplicates and all counted once) is **409** `request_reused`, before any Grant is read | an id reused by mistake must neither act nor answer another request's outcomes |
| Bucket `RESELLER_USER_CONFIG_ACTION`, per request — as the config actions spend it for 1..50 configs | one bulk is one admin decision |

**Not in bulk:** delete (a refund answer per Grant), renew and issue (a
`requestId` per Grant), rotate-token (every user's app would lose its link at
once). A stored outcome is purged 30 days after it was written (F-311-u3,
below), so a repeat that late acts again. **Not covered:** the confirm itself is
the consumer's (F-311-x panel, F-311-y bot).

## By a filter, as a job (built — F-311-u2)

An outage is per panel, and a panel can hold thousands of Grants: the same
acts, chosen by a filter and run by the worker in batches rather than in the
request. `payment/gift/reseller-grants-bulk-job.controller.ts` over
`grant-bulk-job.ts`; the filter's SQL is `grant-bulk-selection.ts`, body
`grant-bulk-job.schema.ts`. All under `POST|GET /api/billing/tenants/:tenantId/grants/bulk-jobs`:

| Route | Door | Answers |
|---|---|---|
| `GET …/panels` (F-311-x1) | `read` | `{panels[{id, name, region, own, retired, grants}]}` — every panel the reseller's `active` / `suspended` Grants have a live config on, **retired included** (the one that was down), `grants` their count; `grant-bulk-selection.ts` `panelsOfSelection`. Declared before `:jobId` |
| `POST …/count` `{filter}` | `read` | `{count}` — what the confirm shows |
| `POST …` a bulk body with `filter` in place of `grantIds` | `staffWrite` | **202** the job; the same `requestId` again answers it |
| `GET …?page&pageSize` | `read` | `{rows[job], page, pageSize, total}`, newest first |
| `GET …/:jobId` | `read` | the job: `{id, requestId, action, command, filter, status, total, processed, ok, refused, failed, createdAt, finishedAt, purgedAt}` |
| `GET …/:jobId/outcomes?page&pageSize&problems` | `read` | `{rows, page, pageSize, purgedAt}` — each reached Grant as a bulk by id answers it, in the order reached; `problems=true` keeps refused and failed |
| `POST …/:jobId/cancel` | `staffWrite` | the job, `cancelled`; a finished one as it is |

`filter` is `{panelId?, productId?, variantId?, statuses?}`, every condition
given holding; `statuses` defaults to `[active]`, so "every active Grant" is
`{}`. A panel is a config on it with `desiredRemote = present`; a product or
variant is what the Grant was issued from.

| Rule | Why |
|---|---|
| **The selection is frozen at the confirm** (user, 2026-09-28): the Grants the filter matches are written as the job's items (`grant_bulk_job_item`) in the start's own transaction, one `INSERT … SELECT` — the count's `WHERE`, the reseller's `tenantId` in it (C-15) | the number confirmed is what is acted on, progress has a fixed denominator, and a Grant bought on that panel a minute later does not get the +3 days |
| **One `requestId`, one job**: a repeat with the same body answers that job and selects nothing again; another body, or an id a bulk by id already used, is **409** `request_reused`; a concurrent repeat collides on `(tenantId, requestId)` | a double click must not start two jobs, i.e. +6 days |
| Nothing matched is **422** `selection_empty`; over 100 000 Grants is **422** `selection_too_large`, and no job is kept | an empty job is a mistake; a larger one is split by panel or product |
| Over the reseller's `bulk_job_grants_max` is **409** `reseller_limit_reached`, `facts {key, limit, used}` (`used` = the job's size), to its own people only; at it is allowed; no job is kept (F-019-t5, `tenant/contract.limits.md`) | the platform bounds how much one reseller's click may move at once; the platform's staff pass (ADR-0106 point 4) |
| **The clock is `worker-service`'s, the work is here** (user, 2026-09-28; ADR-0027): the `grant_bulk_job_drain` tick, `always_on`, asks `POST /api/internal/billing/grant-bulk-jobs/drain` (`ServiceOnlyGuard`), which acts on at most `GRANT_BULK_JOB_BATCH_SIZE` (200) pending items across running jobs, oldest job first | as the purge and the campaigns: one scheduler, bounded ticks, resumable |
| Each Grant is acted on by the bulk by id's own `actOnce`, **in the job's tenant, as the job's admin** (`actorUserId`, `actorIp`, and `byPlatform` — admitted as platform staff, whose `traffic_gift` is the platform's, F-118-ac — kept on the job): its audit row, its notice, its outcome in `grant_bulk_outcome` under the job's `requestId` | a Grant's history and the user's message read the same whichever way the Grants were chosen, and once per Grant holds across both |
| A throw nobody named is tried on 3 drains, then that Grant is `failed`; a refusal is kept at once. The job's counts move per item marked done, and the job is `done` when none is left | a transient error retries; a broken Grant does not stall 8 000 others |
| A cancel stops the Grants not yet reached, within one batch; those reached stand | the admin who chose the wrong panel can stop it, not undo it |
| A started job finishes whatever its tenant's status, as a started campaign (F-018-p); starting and cancelling are the `staffWrite` | a suspension mid-job must not leave half a panel with +3 days and nobody able to see why |
| **The job is audited as one admin act** (F-311-u3): `grant_bulk_start` in the start's transaction (after: action, command, filter, total; reason: the body's) and `grant_bulk_cancel` in a cancel that stopped it (before and after: status and counts), target `grant_bulk_job`. A repeated start and a cancel of an ended job write none; nobody is told | "who gave 8 000 users +3 days, and who stopped it" is one row, beside the 8 000 Grant rows that say what each got |
| **Retention** (F-311-u3, user 2026-09-28): `GRANT_BULK_RETENTION_DAYS` (30) after a job ended, the drain call also deletes its items and its `grant_bulk_outcome` rows and sets `purgedAt` — 5 jobs a call; **the job row and its counts stay**. Its outcomes page then answers no rows and `purgedAt`. A running job is never purged | the per-Grant rows are the bulk of the data; the summary is what an admin asks for later, and it keeps a repeated `requestId` answered |
| A bulk by id's outcomes, which have no job, go 30 days after they were written, 5 000 a call — only those whose `requestId` names no job | a long job's early outcomes are never taken before the job is |

The drain route answers `{jobs, acted, finished, purged, outcomesPurged}`.

## The catalog the users pages name (built — F-311-ab1, D-57)

`GET /api/billing/tenants/:tenantId/users-catalog` -> `{products[{id, nameKey,
isActive, variants[{id, sku, nameKey, isActive}]}]}`:
`payment/gift/reseller-users-catalog.controller.ts`, query
`reseller-users-catalog.ts`, `ResellerUserGrantsService.catalog`; spec
`reseller-users-catalog.spec.ts`. What a bulk filter picks by product and what
an admin issues.

| Rule | Why |
|---|---|
| **The users-admin door, `read`** (`runIncludingPlatform`), no `catalog.manage` | managing users is not editing prices (D-57); a support admin must issue without that right |
| **The tenant is in the query** (C-15): the path's id, or `tenantId` null when the door answers `platform: true` (tenant [contract.entitlements.md](../tenant/contract.entitlements.md)) | catalog RLS is shared-read, so the scope alone adds the platform's products to a reseller's list; the platform's own rows are null, not its id |
| Archived products left out; switched-off products and variants kept, with `isActive` — the issue form offers active ones only, the filter all | a service sold before a switch-off is still filtered by |
| No price, no fulfilment detail | the forms name a plan; billing refuses what it cannot place (`variant_not_deliverable`) |
| The users reads' bucket (`RESELLER_USER_GRANTS_READ`) | one read per opened form, as the page's other reads |

