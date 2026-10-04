---
id: audit
layer: domain
status: active
version: 3
updated: 2026-09-28
---

# Contract — audit

**Partly implemented.** The account-switch group is live end to end for a
user (`auth-service/src/app/account-switch/`): adding (F-0205), listing
(F-0206), switching (F-0207) and removing (F-0208). **An admin's acts on a
user's Grant and configs are audited and read back** (F-311-r,
`billing-service/src/app/grant-audit/`) — see "A Grant's history" below. The
rest of the audit log — each domain's own writes, and impersonation (written
by identity's module) — has no `audit` read or guard yet. Rows below are marked
accordingly.

**Version 2 (2026-09-06, ADR-0015) is a breaking change to every switch-group
operation.** A group is no longer a property of the person: it belongs to the
**switch scope** — one bot chat, or one browser — that it was built on. Every
operation below now reads the caller's scope, and a caller whose scope cannot
be resolved is refused rather than served a global group. Consumers:
`auth-api`, and through it `panel-web` and `bot-app`; all three are updated in
the same change.

## TL;DR

The privileged-action trail. `admin_audit_log` is absolutely append-only (not even a super admin deletes rows) with `oldValue`/`newValue` JSON + admin IP. `impersonation_session` records an admin acting as a user (always paired with an `admin_audit_log` entry). `linked_account_group` + `linked_account_member` model a user's own verified account switching, **per surface** — `@@unique([scopeKey, userId])`, so the same person holds an independent set in each chat and each browser (ADR-0015).

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| append audit entry *(each writer's own; a Grant's acts live, F-311-r)* | adminId, action, target, old/new, ip, `reason?` | `admin_audit_log` row | sync (in caller tx) | — |
| read audit trail *(a Grant's only, F-311-r; by admin / date range intent)* | target ref | rows (read-only) | sync | — |
| record impersonation start/end *(written by identity today)* | adminId, targetUserId, reason, ticket? | `impersonation_session` (+ audit row) | sync tx | (see identity invariants) |
| add an account to a switch group **(live, F-0205)** | caller's session, **caller's scope**, target phone/username + an OTP to that account **or** its password | `linked_account_member` row carrying that scope, `verifiedViaOtp` set accordingly | sync | proof failed, already in a group *on this surface*, no resolvable scope (`accountSwitch.noScope`), rate-limited |
| list the caller's switch group **(live, F-0206)** | caller's session, **caller's scope** | the caller, plus the members **the door admits** they may switch to **in this scope** — the door's tenant's accounts and, on a reseller's panel, its owner (ADR-0059 (5)); phone masked | sync | — (no scope and no group both answer `members: []`) |
| switch to a member **(live, F-0207)** | caller's session, **caller's scope**, target member | the target's token pair + `refresh_token` cookie, the new session stamped with the same scope; the caller's session revoked `account_switched` | sync tx | not a member *of this scope's group*, another group, cross-tenant, target deleted/suspended, no scope — all one answer, `accountSwitch.notAMember` |
| remove an account from the group **(live, F-0208)** | caller's session, **caller's scope**, target member — which may be the caller itself | that scope's member row gone; the removed account's sessions **in that scope** revoked `account_unlinked`; the group deleted if one member would be left | sync tx | not a member, no scope — both `accountSwitch.notAMember` |

## A Grant's history (built — F-311-r)

`grant-audit.ts` in `billing-service` — the second `audit` writer there after
`settlement/`, for the same reason: the acts and their transaction are billing's.
`ResellerUserGrantsService` (billing `contract.reseller-grants.md`) calls it on
every write; the route is `GET …/users/:userId/grants/:grantId/history`.

| Rule | Why |
|---|---|
| **One row per act, inside the act's transaction, after it** (invariant #12): the target's columns read before and after the act (`oldValue` / `newValue`), the act's result as `newValue.outcome`, `adminId`, `adminIpAddress`, `reason`, `tenantId` = the path's reseller | a row never claims a state the act did not leave; a refusal rolls it back with the act |
| Actions `grant_freeze` / `grant_unfreeze` / `grant_duration_change` / `grant_traffic_change` / `grant_traffic_reset` / `grant_traffic_gift` / `grant_speed_set` / `grant_devices_set` / `grant_delete` / `grant_issue` / `grant_renew` / `grant_link_rotate` on target `grant`; `config_regenerate` / `_disable` / `_enable` / `_retire` / `_move` on target `config`; `grant_bulk_start` / `grant_bulk_cancel` on target `grant_bulk_job` (F-311-u3); `grant_limit_tenant_set` on target `tenant`, `grant_limit_user_set` / `grant_limit_user_remove` on target `user`, before/after `{meteredOpenCap}` (F-118-ap, `entitlement/contract.limits.md`); `reseller_limit_set` / `reseller_limit_clear` on target `tenant` (the platform's or a reseller's) or `tenant_feature_package`, before/after `{level, key, value}` (F-019-m, `tenant/contract.limits.md`); `reseller_overage_set` / `reseller_overage_clear` on the same targets, before/after `{level, key, overage}` (F-019-v1); `reseller_overage_cap_set` on target `tenant` (the reseller, in its own log), before/after `{cap}` (F-019-v2) | opposite acts (freeze / unfreeze) must stay tellable apart |
| A repeat that changed nothing (`renewed: false`, `issued: false`) writes **no** row; an issue's target is the Grant it created, with no `oldValue` | the trail lists acts, not requests |
| **No token or link is ever written**: the Grant's snapshot leaves out `subscriptionTokenHash`/`Sealed`, and a rotation's outcome is empty — `tokenRotatedAt` moving is the record | the row is readable by every admin of the reseller |
| `reason` is the admin's text: required where the route requires it (days, traffic, speed, devices, delete), optional on freeze, unfreeze, rotate, issue, renew, and a config disable's own reason | a column, not a JSON field, so a history reads it without knowing each act |
| The read: the Grant's rows **and every config it ever held** (a retired or moved one included), newest first, paged (≤100, default 20), each `{id, action, targetType, targetId, actorUserId, before, after, reason, at}`; door `read`, the path user's Grant (**404** otherwise); the admin's IP is not answered | the reader is the reseller; a suspended one still sees who did what |

Not recorded: the system's own acts (the unfreeze sweep, a quota stop) — they
are not an admin's. Telling the user is the next section's.

## Support consent (built — F-117-a)

`auth-service/src/app/support-consent/`, ADR-0104 (4), catalog §3.7. The
platform's staff reach a reseller's people only under a live consent the
reseller grants; the reader is `liveSupportConsent` (shared-core), and every
door uses it, never its own query.

| Route `/api/auth/tenants/:tenantId/support-consent` | Who | What |
|---|---|---|
| `GET` | anyone `ResellerAccess` admits | `{defaultHours, items[], emergency[]}` — newest 50 of each, each with `state` `requested`/`live`/`expired`/`revoked`/`declined`, derived on read |
| `POST requests` `{scope, reason≥10}` | platform staff only (`only_platform_requests`) | one open request per reseller (`request_pending`, 409) |
| `POST` `{scope, hours?, reason?, requestId?}` | the reseller only (`platform_cannot_grant`) | live from now for `hours` (its default, else 4; 1–24, `hours_out_of_range`); a `requestId` turns that request live with the scope chosen here; any earlier live one is revoked |
| `POST :consentId/revoke` | anyone admitted | ends a request (declined/withdrawn) or a live grant; anything else `consent_not_found` |
| `PUT policy` `{defaultHours}` | the reseller only | its default length, 1–24 |
| `GET activity?page=` | the reseller only (`reseller_only`, 403) | the platform's trail below, 50 a page, newest first |
| `POST emergency` `{reason≥20}` | platform staff holding `tenant.emergency_access` (`emergency_not_permitted`) | tier C below; one running per staff member (`emergency_live`, 409) |
| `POST emergency/:entryId/end` | its entrant only (else `consent_not_found`) | ends it before the hour |

- Scope `read` sees; `act` also acts. Which routes honour it is each door's
  (F-117-b users-admin, F-033-l support).
- Writes take capability `account`: a suspended reseller still grants and revokes.
- **A revoke takes effect on the next request**: nothing caches a consent. An
  impersonation riding on it ends at once (identity `contract.reseller-users.md`, F-117-e).
- **Every query on these tables runs in a `tenantTransaction`**: they are under
  RLS and not in `withTenant`'s registry, so a bare query binds no tenant and
  sees nothing (an insert is refused by the policy).
- Each request, grant and revoke writes one `admin_audit_log` row in the
  reseller's trail (`support_consent_*`, target `support_consent`, before/after
  `{scope, grantedAt, expiresAt, revokedAt}`); the default writes
  `support_consent_policy_set` on target `tenant` (invariant 13).

## Emergency entry — tier C (built — F-117-d)

ADR-0104 (5). Abuse, a legal order, a security incident: what cannot wait for
the reseller's grant. `emergency_access_entry`, `SupportConsentService`.

- **A permission of its own**, `tenant.emergency_access` — granted to no role
  by the migration or the seed; `*` holds it, anyone else is given it by hand.
  Re-read on every request: taking it away ends the entry on the next one.
- **A reason, at least 20 characters**; **exactly one hour** from entry (CHECK);
  **never extended** — while one runs a second is `emergency_live`; once it
  has ended or expired, a new entry is a new row, a new notice, a new reason.
- **It admits its entrant alone**, as `act`, on every door a consent opens
  (users-admin, support's platform inbox): the door tries the reseller's
  consent first, then the caller's own running entry, and records `tier:
  emergency` with `entryId` (the trail below).
- **The owner is told at entry**: the entry, its `emergency_entry_open` audit
  row (with the reason) and an outbox event `tenant.support.emergency_entry`
  commit together — the notice may fail to deliver; the entry stays recorded.
  The notice (`resellerEmergencyEntry`, `critical`) carries no reason; the
  reseller reads it in `GET` above, under `emergency[]`
  (`{id, userId, reason, state live|ended|expired, startedAt, expiresAt, endedAt}`).
- An early end writes `emergency_entry_end`. The reseller cannot end one: tier
  C is the access that does not ask it.

## The platform's trail in a reseller (built — F-117-c)

ADR-0104 (6). **Every request the platform's staff make among a reseller's
people is one `admin_audit_log` row in that reseller's trail — reads too** (an
inbox or a user list viewed is the act). Written by the door that admitted it,
never by the work, so a route added later is recorded without knowing it is:
`ResellerAccess` on the users-admin routes and support's `PlatformSupportDoor`,
both through `recordPlatformAccess` (shared-core `platform-access-trail.ts`).

| Field | Value |
|---|---|
| `action` / target | `platform_access`, target `tenant` = the reseller; `tenantId` the reseller |
| `adminId`, `adminIpAddress` | the staff member, the request's address |
| `newValue` | `{tier, consentId \| entryId, scope, capability, act, target}` — `tier` `consent` (B) or `emergency` (C); `act` the method and route **template**; `target` the path's ids but the reseller's |

- Written in the consent read's tenant transaction, **before the work**: the
  row is the admission, so an act refused after the door still leaves it; the
  act's own row (`grant_freeze`, …) says what changed.
- A refused caller and the reseller's own people leave none.
- The act and target come from the caller's `trace` (`accessTraceOf(req)`),
  set by the controller's `actorOf`; a caller without one is recorded as
  `act: unknown`, never skipped.
- The read (`GET …/support-consent/activity`) answers `{page, items[]}`, each
  `{id, at, actorUserId, tier, consentId, entryId, scope, act, target}`; the
  staff member's address is not in it. Staff are refused it: the rows name
  the reseller's users.

## Emits (events)

**An admin's act, told to the Grant's owner (F-311-s, built).** `auditedGrantAct`
and `auditedConfigAct` write, beside the row and in the same transaction, one
retention outbox row (`grant-audit/admin-notice.ts`, proved by `admin-notice.spec.ts`).
Every act is told; a config's on its Grant:

| Act | Type `entitlement.grant.…` | Params |
|---|---|---|
| freeze / unfreeze | `admin_frozen` / `admin_unfrozen` | — |
| days | `admin_days_added` / `admin_days_removed` | `days`: whole, at least 1 |
| traffic change, gift | `admin_traffic_added` / `admin_traffic_removed` | `amount` ("5.0 GB") |
| reset / delete / link rotate | `admin_traffic_reset` / `admin_deleted` / `admin_link_rotated` | — |
| speed cap set / lifted | `admin_speed_capped` / `admin_speed_uncapped` | `mbps` on a cap |
| device limit set / lifted | `admin_devices_limited` / `admin_devices_unlimited` | `limit` on a limit |
| issue / renew | `admin_issued` / `admin_renewed` | `servicesUrl?` on an issue |
| config regenerate / disable / enable / retire / move | `admin_config_regenerated` / `_disabled` / `_enabled` / `_retired` / `_moved` | — |

`period` is the audit row's id, so the ledger tells each act once. `reactivated`
(optional) on days added, traffic added, reset and renew: the act also brought a
stopped Grant back, and the notice closes with "active again" instead of a
second message (entitlement `contract.retention.md` "Active again"). An issue
is told here because its Grant is born `active`: the purchase's "ready" fires
only on `pending → active`. Never in the payload: the admin's `reason` (staff's
words) or a link. How it is told: notification
[contract.retention.md](../notification/contract.retention.md).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | actor + target identities, OTP/password verification for account linking, and the **session handover** a switch performs (`AuthService.switchSession`) | audit writes blocked -> caller tx aborts |

## Guarantees (intended)

- Audit writes participate in the caller's transaction — an action and its audit row commit or roll back together.
- A switch never widens what the caller can reach: the group is not a shared identity, so the new session carries the **target's** role and permissions and inherits nothing from the account being left.
- At no instant does a switching browser hold two live sessions, or a live session for an account it has not proved. See invariants #6 and #7.
- **No operation reaches outside the caller's scope.** Adding, listing, switching and removing all read `(scopeKey, userId)`, so a group built in a browser is invisible and unreachable from a chat and vice versa — including the removal's session revoke, which is narrowed to that scope (ADR-0015, invariant #8).
- The scope is never taken from a request body. It comes from the `device_id` cookie or from the verified service token plus the bot headers, so a caller cannot name the surface it is acting for.
- **A chat's scope names its bot's tenant** — `bot:<tenantId>:<platform>:<chatId>` (v3, F-061-g). A private chat id is the person's own id with every bot, so without it a reseller's owner met their platform chat's group in their reseller's Mini App. `forward-auth` reads the platform out of it (`contract.headers.md`) and accepts both shapes while pre-v3 sessions live.
- **Who the door admits is the whole tenant rule** (invariant #6). An add proves the account in the door's tenant (falling back to its owner, identity invariant #16), even when the owner's own request runs in their tenant.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| a single global group per user (`linked_account_member.userId` unique) | 2026-09-06 (ADR-0015) | removed in the same change — see below | one group per `(scopeKey, userId)` |

The one break not kept for a release: there is no production deployment and
`prisma/migrations/` does not exist yet (D-5), so the old shape has no consumer
to deprecate for. Existing dev rows were backfilled to the inert scope
`legacy:panel`.
