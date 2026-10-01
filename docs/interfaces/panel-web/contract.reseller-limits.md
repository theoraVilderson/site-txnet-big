---
id: panel-web
layer: interface
status: active
version: 41
updated: 2026-10-01
---

# Contract — panel-web: reseller limits (F-019-r, ADR-0106)

A §10 split of [contract.resellers.md](contract.resellers.md), which is at its
ceiling. The routes and their rules are tenant's
(`domains/tenant/contract.limits.md`); this is the page over them.

## Where

- `/resellers/limits` (`PANEL_RESELLER_LIMITS`, `resellers/limits/_components/LimitsView.tsx`),
  reached from **Limits** on `/resellers`. Platform owner only, as `/resellers`
  (`canAdministerResellers`); anyone else sees `not_platform_owner` and nothing is asked.
- On `/resellers/[id]`, overview tab: **Limits** (`LimitsSection`) — each key in
  effect for that reseller and where it comes from, with a link to the page.

`lib/tenant-api.ts` `resellerLimitsApi`: `table`, `ofReseller`, `setPlatform` /
`clearPlatform`, `setPackage` / `clearPackage`, `setResellers` / `clearResellers`.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | One card per key, in `RESELLER_LIMIT_KEYS` — shared-core's `RESELLER_LIMITS` in its order; the spec reads that file and holds the two together | a key added there with no card here is a limit nobody can set |
| 2 | Every value shown is tenant-service's answer: the table for the page, `GET /tenants/:id/limits` for one reseller (`limit`, `source`). Nothing here decides which level wins. After a save the table is read again | the resolver is the only place the order of levels lives |
| 3 | Each level shows what it holds: a number, **no limit** (`null`), or **not set** (no row — the next level applies). "Back to the next level" (`clear…`) is offered only where the level has a row | no limit and not set are different decisions |
| 4 | A value is a whole number within the key's `max`, or "no limit" ticked → `null` (`limitValueOf`); anything else keeps save off. An empty box is never 0 | 0 refuses everything |
| 5 | **For chosen resellers**: one request for every ticked reseller (from `tenantApi.resellers(100, 0)`), the value and a reason — the button waits for at least one reseller and a reason; tenant-service writes all or none | ADR-0106 "several resellers"; the reason is kept on each row and audit |
| 6 | A reseller's own value is listed with its reason and removed alone (`clearResellers(key, [id])`) | a reseller's limit stays that reseller's |
| 7 | Refusals are tenant-service's sentence (`useMessage`), on the card that asked | `unknown_limit`, `limit_out_of_range`, `package_not_found`, `reseller_not_found` |

## Proof

`resellers/limits.test.tsx` — the keys against shared-core's file, `limitValueOf`,
each level's value from the table, the platform's saved as a number and as
no limit, several resellers only with someone picked and a reason, one
reseller's own value removed, nobody but the platform owner.

## Not covered

More than 100 resellers to pick from (the list asks one page); a reseller
seeing its own limits (F-019-s).
