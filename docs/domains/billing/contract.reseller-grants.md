---
id: billing
layer: domain
status: active
version: 63
updated: 2026-09-28
---

# Contract — billing / a reseller's admin on one user's services

A §10 split of [contract.gift.md](contract.gift.md), which was at its ceiling.
The routes under `/api/billing/tenants/:tenantId/users/:userId/…` (F-311): a
reseller's admin reads one of its users' services and acts on them. The
entitlement rules they call are entitlement's
[contract.admin.md](../entitlement/contract.admin.md).

## One user's services, read by a reseller's admin (built — F-311-f)

`payment/gift/reseller-user-grants.controller.ts` over `ResellerUserGrantsService`,
which asks the four owner reads of [contract.gift.md](contract.gift.md) — `GrantService.listForUser`,
`UserConfigsService.listForGrant`, `GrantUsageService.dailyForGrant`,
`SubscriptionLinkService.linkFor` — unchanged, with the **path's** user.

| Route (`/api/billing/tenants/:tenantId/users/:userId/grants…`) | In | Answers `data` |
|---|---|---|
| `GET …/grants` | the Grant list's query (`page`, `pageSize`, `scope`, `q`) | the owner list's page, as there |
| `GET …/grants/:grantId/configs` | — | `{grantId, rows[]}`, the owner's config view, `lines` and `login` included |
| `GET …/grants/:grantId/usage` | — | `{grantId, from, to, days[]}`, as there |
| `GET …/grants/:grantId/subscription-link` | — | `{grantId, subscriptionUrl}`; its two 409s as there |

| Rule | Why |
|---|---|
| `ResellerAccess` (F-066-w1) is the door, capability `read`, no permission guard; refusals travel as `reason` — `not_allowed` / `reseller_suspended` **403**, `reseller_not_found` **404**, `reseller_terminated` **409** | every reseller-named surface (`contract.revenue.md`); a suspended reseller still sees its users' services |
| **The reseller is the path's**, and every read runs in its scope | the owner's session carries the platform's `X-Tenant-Id` (ADR-0059) |
| **Only that reseller's users** (C-15): the user is read first, in the reseller's scope (`user` is RLS-strict and in `TENANT_SCOPED_MODELS`); another tenant's user or none is **404** `user_not_found`, and no Grant is read for them | the Grant reads fence only by `userId`, and `traffic_daily_aggregate` has no tenant at all |
| The owner reads are asked **as the path's user**, so a Grant of another user of the same reseller is their own **404** `grant_not_found` | their ownership check is the only one that knows a Grant's user |
| One bucket for all four, `RESELLER_USER_GRANTS_READ`, default **300**/900s per caller; none of the four writes or rotates | expanding one Grant asks three routes at once. Reset link is F-311-n; config actions are the next section |

**Not covered:** retired configs (the owner's view leaves them out), and an audit
row for a read (F-311-r audits actions only). Its consumers are F-311-v (panel)
and F-311-y (bot).

## An admin's actions on one user's configs (built — F-311-g)

`POST /api/billing/tenants/:tenantId/users/:userId/configs/actions`, on the same
controller, over `ResellerUserGrantsService.act` -> `UserConfigsService.actAsAdmin`
-> `ConfigActionsService` with `actorType = admin`, `actorId` = the caller.

| In | Answers `data` |
|---|---|
| `{action: regenerate \| disable \| enable \| retire \| move, configIds[1..50], reason?, toPanelId?}` — `reason` (1..200, the config's `disabledReason`) with `disable` and only with it; `toPanelId` with `move` and only with it | `{action, results[{configId, ok: true, movedTo?} \| {configId, ok: false, reason}]}` — always **200**; `movedTo` is a move's new config id |

| Rule | Why |
|---|---|
| The door is `ResellerAccess` with capability **`staffWrite`**: a suspended reseller (`read_only`, §14.6) is **403** `reseller_suspended` and nothing is read or written; platform staff pass, as on every reseller surface | it still reads its users' services (the section above) but changes none |
| The user is the reseller's (C-15) before any config is read, as above: **404** `user_not_found` | the same fence as the reads |
| **A config must be the path's user's**, read in the action's own transaction; any other — another user of the same reseller included — is the outcome `config_not_found` and is never acted on | an `admin` actor passes `ConfigActionsService`'s ownership check for every config; this is the only fence |
| One transaction per config, ids deduplicated, in the order named; `reason` is `CONFIG_ACTION_REJECTIONS` or `failed` — the owner route's rules (`contract.gift.md`), unchanged | one refused config must not stop the others |
| **An admin's regenerate is outside the user's cap**: not checked, not counted (network `contract.provisioning.md`); the log row says `admin` | support rotating a leaked credential must not spend one of the user's three |
| A move goes to a panel shared or dedicated to the Grant's tenant, not archived, not the config's own (`panel_not_found`, `same_panel`), and only while the Grant is `active` (`grant_not_active`) — `ConfigActionsService.move`, unchanged | the new row is provisioned like a purchase's |
| Bucket `RESELLER_USER_CONFIG_ACTION`, default **60**/900s per caller, per request | acting must not spend the budget for looking |

## An admin freezes one of a user's Grants (built — F-311-h)

`POST /api/billing/tenants/:tenantId/users/:userId/grants/:grantId/freeze`, body
`{until?}` (ISO instant with offset) -> `{grantId, frozenUntil, configsDisabled}`;
`POST …/grants/:grantId/unfreeze` -> `{grantId, endsAt, configsRestored}`. Same
controller, over `freezeGrant` / `unfreezeGrant` (entitlement `contract.admin.md` "Freeze").

| Rule | Why |
|---|---|
| Door `staffWrite`, the reseller's user (**404** `user_not_found`) and **the path user's Grant** (**404** `grant_not_found`, read in the write's transaction) — as for config actions | the same fences |
| **409** `grant_not_active` (freeze), `grant_not_frozen` / `grant_moved` (unfreeze); **400** `freeze_until_not_future` | a quota stop stays the top-up's; a raced end is retried, never shifted twice |
| Bucket `RESELLER_USER_CONFIG_ACTION`, shared with the config actions | both are an admin's writes on a user's service |

**Not covered:** a reason and the audit row (F-311-r), telling the user (F-311-s).

## An admin changes one of a user's Grants' days (built — F-311-i)

`POST /api/billing/tenants/:tenantId/users/:userId/grants/:grantId/duration`, body
`{days | endsAt, reason}` — exactly one of `days` (whole, ±1..3650) or `endsAt`
(ISO instant with offset); `reason` 1..500 chars -> `{grantId, changeId,
endsAtBefore, endsAtAfter}`. Same controller, over `changeGrantDuration`
(entitlement `contract.admin.md` "Days").

| Rule | Why |
|---|---|
| Door `staffWrite`, the reseller's user and the path user's Grant — as for a freeze | the same fences |
| **409** `grant_closed`, `grant_not_active`, `grant_permanent`, `grant_moved`; **400** `duration_end_not_future`, `duration_unchanged` | a closed Grant is renewed, never re-dated |
| Bucket `RESELLER_USER_CONFIG_ACTION`, shared with the freeze | one admin's writes on a user's service |

**Not covered:** reading the history back (F-311-r), telling the user (F-311-s).

## An admin changes one of a user's Grants' traffic (built — F-311-j)

`POST …/users/:userId/grants/:grantId/traffic`, body `{gb, reason}` — `gb` ±GiB
(fractions allowed, never 0, |gb| ≤ 100 000); `reason` 1..500 chars -> `{grantId,
adjustmentId, purchasedBytesBefore, purchasedBytesAfter, usedBytes, spent, revived}`
(bytes as strings). Same controller, over `adjustGrantTraffic` (entitlement
`contract.admin.md` "Traffic"). `spent`: the new Quota is at or below Used — the
planner closes it and it is suspended from that close (ADR-0096).

| Rule | Why |
|---|---|
| Door `staffWrite`, the reseller's user and the path user's Grant — as for days; bucket `RESELLER_USER_CONFIG_ACTION` | the same fences |
| **409** `grant_closed`, `grant_not_active`, `traffic_not_adjustable`, `grant_moved`; **400** `quota_below_zero` | only a prepaid, limited bag moves |

**Not covered:** a panel list for the admin to pick a move's target from (the
owner's systems page has one; a reseller's admin has none yet), an audit row
beyond `config_action_log` (F-311-r), telling the user (F-311-s). A move of a
panel group's config lands outside the group, as `move` always has. Consumers
F-311-v (panel), F-311-y (bot).

## An admin resets one of a user's Grants' traffic (built — F-311-k)

`POST …/users/:userId/grants/:grantId/traffic/reset`, body `{reason}` (1..500
chars) -> `{grantId, adjustmentId, purchasedBytesBefore, purchasedBytesAfter,
usedBytes, resetBytes, spent, revived}` (bytes as strings). Same controller, over
`resetGrantTraffic` (entitlement `contract.admin.md` "Reset"): Quota rises by
`resetBytes`, what was used since the last reset, so the full bag is left again;
the meter is never zeroed (user, 2026-09-26).

| Rule | Why |
|---|---|
| Door `staffWrite`, the reseller's user and the path user's Grant; bucket `RESELLER_USER_CONFIG_ACTION` — as for traffic | the same fences |
| **409** `grant_closed`, `grant_not_active`, `traffic_not_adjustable`, `nothing_to_reset`, `grant_moved` | only a prepaid, limited bag that was used since its last reset |

**Not covered:** the audit row (F-311-r), telling the user (F-311-s). Consumers F-311-w (panel), F-311-y (bot).

## An admin gifts bytes to one of a user's metered Grants (built — F-311-l)

`POST …/users/:userId/grants/:grantId/traffic/gift`, body `{gb, reason}` — `gb`
GiB given (> 0, fractions allowed, ≤ 100 000); `reason` 1..500 chars ->
`{grantId, adjustmentId, purchasedBytesBefore, purchasedBytesAfter, usedBytes,
revived}` (bytes as strings). Same controller, over `giftGrantBytes`
([contract.traffic-block.md](contract.traffic-block.md) "An admin's gift"):
the bag rises, no wallet debit, and the remainder credit at close never pays a
gifted byte back as money.

| Rule | Why |
|---|---|
| Door `staffWrite`, the reseller's user and the path user's Grant; bucket `RESELLER_USER_CONFIG_ACTION` — as for traffic | the same fences |
| **409** `grant_not_metered`, `grant_closed`, `grant_not_active`, `grant_moved` | a prepaid bag is moved by `…/traffic`; a raced block is retried |

**Not covered:** the audit row (F-311-r), telling the user (F-311-s). Consumers F-311-w (panel), F-311-y (bot).

## An admin deletes one of a user's Grants (built — F-311-m)

`POST …/users/:userId/grants/:grantId/delete`, body `{refund, reason}` — `refund`
boolean, always asked (the admin's answer, user 2026-09-26); `reason` 1..500 chars
-> `{grantId, deletionId, statusBefore, configsReleased, refund, refundedAmount,
walletTransactionId, refundSkipped}` (`refundedAmount` a decimal string or null).
Same controller, over `deleteGrant` (entitlement `contract.admin.md` "Delete") with
`RemainderCreditService.credit` ([contract.traffic-block.md](contract.traffic-block.md)
"The remainder") as its settler: `cancelled`, every config released from its panel
now, rows kept; `refund` credits a metered Grant's unserved remainder as
`traffic_refund`, and `refundSkipped` says why one asked for credited nothing.

| Rule | Why |
|---|---|
| Door `staffWrite`, the reseller's user and the path user's Grant; bucket `RESELLER_USER_CONFIG_ACTION` — as for traffic | the same fences |
| **409** `grant_closed`, `grant_not_active` (pending), `grant_moved` | a closed Grant is already off; a pending one is the delivery's |
| A prepaid Grant's refund credits nothing (`grant_not_metered`): F-027-r prices only a metered bag | no pro-rata price for a prepaid bag exists yet |

**Not covered:** the audit row beyond `grant_deletion` (F-311-r), telling the user (F-311-s). Consumers F-311-w (panel), F-311-y (bot).
