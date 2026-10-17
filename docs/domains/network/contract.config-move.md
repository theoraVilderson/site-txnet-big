---
id: network
layer: domain
status: active
version: 2
updated: 2026-10-17
---

# Moving many configs as a job (F-311-ad), releasing an inbound (F-027-es), and Grants to another group (F-027-et)

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

`config-move-job.spec.ts` pins the rules above. The drain is `config-move-drain.ts`.

## Releasing an inbound from groups (F-027-es)

The way out of `inbound_has_configs` ([contract.inbounds.md](contract.inbounds.md)
rule 3a, ADR-0127 decision 6): a job of this table, `kind` `release_move` or
`release_empty` (`to_panel` is the reseller's move above), started from the
systems routes (billing [contract.panel-groups.md](../billing/contract.panel-groups.md)
rule 24g, `systems/inbound-release.ts`). `source` is `{panelId, remoteId,
groupIds}`, `toPanelId` null, `orphans` an `empty`'s (CHECK
`config_move_job_kind_fits`); migration `20261017000500_an_inbound_is_released_by_a_job`.
`network.inbound_release` — key `(groupId, panelId, inboundRemoteId)`,
`tenantId` the group's (null = the platform's, policied as
`panel_group_member_inbound`), `jobId` — is the hold while it runs.

| Rule | Why |
|---|---|
| **The admin chooses, never a side effect**: each group named is a member that sells the inbound now (every member of an `every_group` one, else its listings) and none is already being released (`not_a_seller`, `already_releasing`, 409) | one wrong click must not change hundreds of links |
| At the start, under the panel's fulfilment lock: the live configs of those groups' Grants **naming** that inbound — every tenant's, each item its config's tenant — are the items, and one `inbound_release` row per group is written. A row that names no inbound yet (rule 7) is left out | a platform group serves resellers' users; a row with no inbound may be on another one |
| **While the job runs, fulfilment places none of those groups' Grants there** (`sellingInbounds` and the due scan read the hold) | a buyer placed mid-release would be left on an inbound its group no longer sells |
| `move`: each config is drained and its Grant's group fulfilled in the same transaction — the hold keeps it off this inbound, so it lands on the next placement. A Grant left with no live line is `no_target` and rolls back: reported, left serving | the user is moved, never cut off |
| `empty`: each config is retired there; an active Grant left with no live line is paused or refunded as `orphans` says (`GroupDrainService.orphans`, as an evict, F-027-eg) | a paid Grant is never left with nothing and nothing said |
| **The listing changes only when the job ends**, in the drain's transaction that ends it (`applyRelease`): an `every_group` inbound becomes `listed` to every other member; a `listed` one loses those groups' listings; the hold goes. Nothing to move ends the job at once | a cancel leaves the listing exactly as it was |
| A cancel removes the hold and changes nothing else; the configs moved or emptied stay so | it stops the job, it does not undo it |
| Each act is audited on its config with the job's reason, in the config's tenant (`config_move` / `config_retire`); the job's start and cancel as above; progress by the same event to the job's tenant | one config's history reads the same whoever moved it |

`inbound-release.spec.ts` pins these.

## Moving Grants to another group (F-027-et)

ADR-0127 decision 5. **Only `grant.panelGroupId` changes**: money, quota and end
stay. The act is `GrantRegroupActs.regroup` (`traffic/grant-regroup.ts`), one
Grant in its tenant's transaction; many are a job of this table, `kind`
`to_group`, `toGroupId` the target, `source` `{grantIds}` (1–500) or
`{fromGroupId}` — and **an item names a Grant** (`configId` holds its id);
outcomes answer `{grantId, ok, reason?}` (migration `20261017000600_a_grant_moves_to_another_group`).

| Route (`{toGroupId, reason}` one; `{requestId, source, toGroupId, reason}` a job) | Who |
|---|---|
| `POST /api/billing/systems/grants/:grantId/group`, `…/systems/grant-group-moves` + `/count`, `/:jobId`, `/:jobId/outcomes`, `/:jobId/cancel` | the owner (`panelScopeOf`): any tenant's Grants, any group; never bounded |
| `POST /api/billing/tenants/:tenantId/users/:userId/grants/:grantId/group`, `…/tenants/:tenantId/grant-group-moves` + `/count`, and `ResellerJobRoutes`' four | a reseller's admin, `grant.assign`: its own Grants, into **a group its tenant sells** (a variant of its catalog for sale names it), else 404 `group_not_found` |

One answers `{grantId, fromGroupId, toGroupId, kept, moved}`; `count` answers
`{grants, keep, move}` — configs that keep their link and that get a new one.

| Rule | Why |
|---|---|
| **A config on an inbound the target sells on that panel stays** — a non-`drain` member, the inbound listed to it or `every_group`, not being released; a row with no inbound, on any member. Same client, same link | the point of a shared inbound: users moved between groups keep their line |
| Every other live config is drained, audited `config_move` with the reason (the user told), and the target's fulfilment places the Grant **in the same transaction**, under its panels' locks, against every cap | moved, never cut off; nobody takes a seat twice |
| Refused before any write: no group or not `pending`/`active` (`grant_not_movable`), `same_group`, a group it may not use (`group_not_for_grant`: not the platform's or its tenant's), one that cannot deliver a sale (`target_not_deliverable`, F-111-i), or a kept config over the target's share or member cap (`target_full`, F-027-eq). 404 `grant_not_found` / `group_not_found`, the rest 409 | the move is the target's to carry or not |
| A Grant that held a line and would be left with none is `no_target`, and the whole move rolls back | the target's panels cannot place it now; it stays serving where it was |
| A reseller's own people (a reseller's job, or `as !== 'staff'`) spend its `platform_open_grants_max` / month's traffic room only when the move takes the Grant onto a platform panel it was not on (`reseller_limit_reached`) | ADR-0106: one more Grant on the platform's panels |
| Written down against the Grant, `grant_group_move` (`{panelGroupId}` before and after, `{kept, moved}`), no notice of its own; a job's start and cancel as above; its list is `to_group` jobs only, as a move job's is `to_panel` only | "who put this user on that group" is one row |

`grant-regroup.spec.ts` pins the act; the selection is `grant-regroup-selection.ts`.
