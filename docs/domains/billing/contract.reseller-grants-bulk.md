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

Every body is `{action, grantIds[1..50], reason, …}`; `reason` (1..500) is
**required** for every action, freeze and unfreeze included. Bytes are decimal
strings, dates ISO. Answers **200** `{action, results[{grantId, userId, ok: true,
result} | {grantId, ok: false, reason, panels?}]}`.

| Rule | Why |
|---|---|
| Door `ResellerAccess` **`staffWrite`**, once, before any Grant is read; its refusals as every reseller route's (`resellerRefusal`: 403 / 404 / 409) | a suspended reseller reads its users' services but changes none |
| **A Grant must be the reseller's** (C-15): read by id *and* the path's `tenantId` in the act's own transaction; another tenant's Grant, or none, is `grant_not_found` and is not acted on | no path user to check; `grant` is RLS-strict but not in `TENANT_SCOPED_MODELS`, so the query says it |
| One transaction per Grant, ids deduplicated, in the order named; a refusal is that Grant's `reason` — the single route's (`grant_not_active`, `grant_closed`, `traffic_not_adjustable`, …; `rate_limit_unsupported` with `panels`) — and any other throw is `failed`, logged; the rest still run | one frozen or closed Grant must not stop 49 others; a Grant named twice gets +3 days once |
| Each Grant is one `admin_audit_log` row (the single route's `action`) and one notice to its user, in its transaction | the Grant's history and the user's message read the same as for one Grant |
| Bucket `RESELLER_USER_CONFIG_ACTION`, per request — as the config actions spend it for 1..50 configs | one bulk is one admin decision |

**Not in bulk:** delete (a refund answer per Grant), renew and issue (a
`requestId` per Grant), rotate-token (every user's app would lose its link at
once). **Not covered:** a repeated request is not deduplicated — a second click
adds the days again; the confirm is the consumer's (F-311-x panel, F-311-y bot).
Choosing Grants by a filter (a panel, a plan, "every active Grant") rather than
by id is not built.
