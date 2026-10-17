---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-17
---

# Contract — panel-web: moving Grants to another panel group (F-027-ev)

A topic file of [contract.md](contract.md) beside
[contract.systems.md](contract.systems.md), which is at §10's ceiling, and
[contract.reseller-users.md](contract.reseller-users.md). ADR-0127 decision 5:
a Grant moves to another group by the owner's choice — money, quota and end
stay; a config on an inbound the target also sells keeps its link, the rest
are placed anew. Code: `_components/group-move/GroupMoveDialog.tsx` (the
sheet and `GroupMoveButton`), `GroupMoveJobCard.tsx` (the job), rules
`_lib/group-move.ts`, calls `lib/billing/grant-group-moves.ts`; billing's
routes are network [contract.config-move.md](../../domains/network/contract.config-move.md)
"Moving Grants to another group".

## Where it opens

| From | Source | Door (`GroupMovesApi`) |
|---|---|---|
| a group card's menu on `/systems` («انتقال به گروه دیگر») | `{fromGroupId}`, every Grant of the group | the owner's, `systemsGroupMovesApi()`: any group (`/systems/panel-groups`) but the group itself |
| the ticked found services on a users page (`FindByLink`, `/users` and `/my-resellers/:id/users`) | `{grantIds}`, the ticked ones (≤50 there; billing takes 500) | a reseller's, `resellerGroupMovesApi(id)`: only the groups its tenant sells, `GET …/grant-group-moves/groups` |

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | **The preview is billing's `count`** for the target picked — Grants, configs that keep their link, configs that get a new one — and the start waits for it; a count for another target is never shown | the admin decides on what will happen, not on a guess |
| 2 | **The body is billing's** (`validateGroupMove`): one source, a target other than the source group, a reason 1–500; each Grant once. The start is behind a confirm naming the group and the configs that get a new link | billing refuses a bad body whole |
| 3 | **One `requestId` per opened sheet**: a double click starts one job; a sheet opened again is a new request | `request_reused` is a real refusal, not a retry |
| 4 | **The job is shown live** (C-14): status, progress over the frozen total, moved / refused / failed, a stop. It is read once on mount, then on `network.config_move_job.progress` for its own `jobId` on the **starter's `user:` channel** — never polled. Closing the sheet never stops it | a reseller's admin on the platform's panel is on the platform tenant; the reseller's `tenant:` channel is not theirs |
| 5 | **Every refused Grant is listed with its sentence** when the job ends (`groupMoveRefusalKey`, 20 a page): each of billing's `GRANT_REGROUP_REJECTIONS`, `reseller_limit_reached`, and `failed` for a reason with no sentence yet; a purged job says so | "failed" alone tells the admin nothing to fix |
| 6 | An error on the call itself is the move's sentence when it is one of its reasons, else the page's own (`useSystemsError` / `useUserMessage`) | one sheet, two pages' doors |
| 7 | The job's end re-reads what the page shows: the groups on `/systems`, the search on a users page | the counts it shows have changed |

`group-move.test.ts` pins rules 2, 4 and 5 and both doors' paths.
