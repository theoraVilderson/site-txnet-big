---
id: network
layer: domain
status: active
version: 1
updated: 2026-10-17
---

# Moving many configs to one panel, as a job (F-311-ad)

A topic file of `contract.md` (§10), beside [contract.provisioning.md](contract.provisioning.md),
whose `ConfigActions.move` is the one act every move here runs. A reseller's
admin moves its users' configs between its own panels (D-63, user 2026-10-06):
every live config on a panel that is failing, or every config of the users
ticked, to a target from `move-targets` (billing
[contract.reseller-grants.md](../billing/contract.reseller-grants.md), F-311-v1).
The code is billing-service's (`payment/gift/config-move-job.ts`, the
selection `config-move-selection.ts`, the body `config-move-job.schema.ts`),
as every desired-state writer is (ADR-0071). The page is F-311-ae.

## Routes

All under `/api/billing/tenants/:tenantId/configs/move-jobs`
(`reseller-config-move-job.controller.ts`; the list, one job, outcomes and
cancel are `ResellerJobRoutes`', shared with the bulk job by filter):

| Route | Door | Answers |
|---|---|---|
| `POST …/count` `{source, toPanelId}` | `read` | `{count}` — what the confirm shows |
| `POST …` `{requestId, source, toPanelId, reason}` | `staffWrite` | **202** the job; the same `requestId` again answers it |
| `GET …?page&pageSize` | `read` | `{rows[job], page, pageSize, total}`, newest first |
| `GET …/:jobId` | `read` | `{id, requestId, source, toPanelId, reason, status, total, processed, ok, refused, failed, createdAt, finishedAt, purgedAt}` |
| `GET …/:jobId/outcomes?page&pageSize&problems` | `read` | `{rows[{configId, ok: true, movedTo} \| {configId, ok: false, reason}], page, pageSize, purgedAt}` in the order reached |
| `POST …/:jobId/cancel` | `staffWrite` | the job, `cancelled`; an ended one as it is |

`source` is `{panelId}` or `{userIds}` (1–500), exactly one; `reason` 1–500.
`POST /api/internal/billing/config-move-jobs/drain` (`ServiceOnlyGuard`)
answers `{jobs, moved, finished, purged}` to worker-service's
`config_move_job_drain` tick (`always_on`). Refusals: the door's
(`resellerRefusal`); 404 `panel_not_found` (the target is no move target),
`job_not_found`; 409 `request_reused`; 422 `same_panel`, `selection_empty`,
`selection_too_large`.

## The tables

`network.config_move_job` — `tenantId`, `requestId` (unique per tenant),
`fingerprint`, `actorUserId`, `actorIp`, `reason`, `source`, `toPanelId`,
`status` (`running` / `done` / `cancelled`), `total` and the three counts,
`finishedAt`, `purgedAt`. `network.config_move_job_item` — key `(jobId,
configId)`, `tenantId`, `attempts`, `doneAt`, `ok`, `reason`, `movedTo`.
Tenant RLS on both; the drain reads through `txnet_cross_tenant`
(migration `20261017000400_a_reseller_moves_configs_as_a_job`).

## The rules

| Rule | Why |
|---|---|
| **The selection is frozen at the confirm**: the reseller's own configs (the tenant in the query, C-15), live — `present`, not retired, not drained — not already on the target, on the source panel or of a user named, written as the items in the start's transaction (`INSERT … SELECT`, at most 100 000) | the count confirmed is what moves; progress has a fixed denominator |
| The target is a move target (`moveTargetWhere`: shared or the reseller's own, accepted, not retired) and not the source panel; nothing matched is 422 and no job is kept | a move to a panel nothing provisions strands the config |
| **One `requestId`, one job**: a repeat with the same body answers it; another body is 409 `request_reused`; a concurrent repeat collides on the key | a double click must not start two moves |
| **Each config is `ConfigActions.move`, in the job's tenant, as the job's admin** (`actorType admin`), audited as the single move is — `config_move` with the job's reason, the user told (`auditedConfigAct`) — at most `CONFIG_MOVE_BATCH_SIZE` (50) a drain, oldest job first | a config's history and the user's message read the same as one move |
| **An item's outcome commits with its move**: marked done inside the move's transaction, only where it was not; another drain's mark rolls this one back | two drains move a config once, and a retry never reads its own finished move as `config_retired` |
| A refusal — `ConfigActions`' own, or `already_on_target` (the Grant already has a live config of that protocol on the target) — is kept at once; any other throw is tried on 3 drains, then `failed` | a broken config does not stall the job; a Grant never gets a second line on one panel |
| **Progress by outbox event** (C-14): each job's batch, its end and a cancel write `network.config_move_job.progress` `{tenantId, jobId}`, pushed live to `tenant:` (`LIVE_PUSH_FIELDS`) | the page re-reads the job; it never polls |
| A cancel stops the configs not yet reached; those moved stay moved. Start and cancel are one admin row each (`config_move_start`, `config_move_cancel`, target `config_move_job`) | the wrong panel can be stopped, not undone; "who moved 3 000 users" is one row |
| A started job finishes whatever its tenant's status; starting and cancelling are the `staffWrite` | a suspension must not strand half a panel's users mid-move |
| 30 days after a job ended (`CONFIG_MOVE_RETENTION_DAYS`) the drain deletes its items and sets `purgedAt`, 5 jobs a call; the job row and counts stay | the per-config rows are the bulk; the summary is what is asked later |

`config-move-job.spec.ts` pins the rules above.
