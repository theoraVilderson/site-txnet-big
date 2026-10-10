---
id: billing
layer: domain
status: active
version: 86
updated: 2026-10-10
---

# Contract — the key each act on a user's services asks

A topic file of [contract.md](contract.md) (§10). The member-door key every
route of [contract.reseller-grants.md](contract.reseller-grants.md) passes to
`ResellerAccess.for(key)` (KS-1-a, ADR-0140): one key per kind of act, so a
reseller can give its support staff the services to see and repair and not
the ones that move value. The owner and platform staff are admitted as before;
the key decides only for the tenant's own members.

| Key | Acts | Code |
|---|---|---|
| `grant.read` | a user's Grants, a Grant's configs, its 30-day usage, its `/sub` link, its history; the search by a pasted line (`grants/by-lines`) | `ResellerUserGrantsService`: `grants`, `configs`, `usage`, `subscriptionLink`, `history`, `findByLines` |
| `grant.repair` | a new `/sub` link (`rotate-token`); config actions `regenerate`, `disable`, `enable`, `move`, and the move targets | `rotateLink`, `act` (not `retire`), `moveTargets` |
| `grant.assign` | everything else: config `retire` (a retired config is not given back), freeze, unfreeze, days, traffic, reset, gift, speed, devices, delete, issue, renew, the users catalog, bulk work and jobs, the issuing caps | the rest of the service, `GrantBulkJob`, `GrantLimitsService` |

Rules:

1. **A route that names no key asks `grant.assign`**, the default of the
   service's `run`/`admitted`: a new act is value-moving until someone decides
   it is not.
2. **Holding a split is migration-made** (`20261010000100`): every holder of
   `grant.assign` — role, group or person, a `take` included — holds all three,
   so nobody lost an act (ADR-0140 (3)).
3. **The panel offers what the key opens** (`grantKeyHeld`, `GRANT_ACTION_KEY`,
   `CONFIG_ACTION_KEY`, panel-web `contract.reseller-users.md`); the door is
   still the boundary.

Proof: `payment/gift/grant-keys.spec.ts` — the key each service method asks.
