---
id: billing
layer: domain
status: active
version: 86
updated: 2026-10-13
---

# Contract — the key each act on a user's services asks

A topic file of [contract.md](contract.md) (§10). The member-door key every
route of [contract.reseller-grants.md](contract.reseller-grants.md) passes to
`ResellerAccess.for(key)` (KS-1-a, KS-1-c, ADR-0140): one key per kind of act, so a
reseller can give its support staff the services to see and repair and not
the ones that move value. The owner and platform staff are admitted as before;
the key decides only for the tenant's own members.

| Key | Acts | Code |
|---|---|---|
| `grant.read` | a user's Grants, a Grant's configs, its 30-day usage, its `/sub` link, its history; the search by a pasted line (`grants/by-lines`) | `ResellerUserGrantsService`: `grants`, `configs`, `usage`, `subscriptionLink`, `history`, `findByLines` |
| `grant.repair` | a new `/sub` link (`rotate-token`); config actions `regenerate`, `disable`, `enable`, `move`, and the move targets | `rotateLink`, `act` (not `retire`), `moveTargets` |
| `grant.compensate` | days or traffic onto a user's Grant, within the tenant's cap (below); reading that cap | `compensate`; `GrantLimitsService.compensationCap` (or `grant.assign`) |
| `grant.assign` | everything else: config `retire` (a retired config is not given back), freeze, unfreeze, days, traffic, reset, gift, speed, devices, delete, issue, renew, a move to another group (F-027-et), the users catalog, bulk work and jobs, the issuing caps | the rest of the service, `GrantBulkJob`, `GrantLimitsService` (setting the compensation cap included) |

Rules:

1. **A route that names no key asks `grant.assign`**, the default of the
   service's `run`/`admitted`: a new act is value-moving until someone decides
   it is not.
2. **Holding a split is migration-made** (`20261010000100`, `20261013000100`):
   every holder of `grant.assign` — role, group or person, a `take` included —
   holds all four, so nobody lost an act (ADR-0140 (3)).
3. **The panel offers what the key opens** (`grantKeyHeld`, `GRANT_ACTION_KEY`,
   `CONFIG_ACTION_KEY`, panel-web `contract.reseller-users.md`); the door is
   still the boundary.

Proof: `payment/gift/grant-keys.spec.ts` — the key each service method asks.

## Compensation (KS-1-c)

`POST …/users/:userId/grants/:grantId/compensate` — `{ days }` (whole, > 0)
or `{ gb }` (> 0), never both, and a `reason`. The way support gives an
apology without `grant.assign`'s unbounded acts.

4. **The cap is per Grant over a rolling 30 days**, each kind on its own:
   `grant_compensation_cap` (one row per tenant: `days`, `bytes`), none = the
   platform's 3 days / 5 GiB (`PLATFORM_COMPENSATION_CAP`); 0 closes that kind.
   It binds whoever uses this route, the owner and platform staff included —
   their unbounded acts are `grant.assign`'s routes.
5. **Counted from the ledger, under a lock.** `claimCompensation` locks the
   Grant (`FOR UPDATE`), sums its `grant_compensation` rows since 30 days ago,
   and writes one row for what it admits — so neither ten small acts nor two at
   once pass the cap. Over it: **409** `compensation_over_cap` with
   `windowDays`, `capDays`, `capBytes`, `usedDays`, `usedBytes`; nothing written.
6. **The act is an existing one, audited as it**: days are
   `grant_duration_change`, traffic `grant_traffic_change` on a prepaid bag or
   `grant_traffic_gift` on a metered one (bought wholesale, as a gift is); the
   audit's outcome carries `compensationId`, and the user is told as for that
   act. Same transaction: a refused act takes its ledger row back.
7. **The cap's routes**: `GET/PUT …/tenants/:tenantId/compensation-cap`,
   body `{ cap: { days, gb } | null }` (`null` = the platform's), bounded at
   365 days / 10 000 GiB. A change is audited `grant_compensation_cap_set`
   (before/after), and a save that changes nothing writes no row.

Proof: `payment/gift/grant-compensation.spec.ts` — the keys, the window, the
default, the refusal, the lock.
