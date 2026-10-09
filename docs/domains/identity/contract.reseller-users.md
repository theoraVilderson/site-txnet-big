---
id: identity
layer: domain
status: active
version: 31
updated: 2026-10-09
---

# Contract — identity / a reseller's own users

A topic file of [contract.md](contract.md) (§10), opened because that file is at
its 250-line cap. What a reseller may know and decide about the people who
registered on its domain (F-311-a, spec F-311): read a page of them, block one,
lift the block, read one and edit their profile (AC-1-a). Wire shapes — paths, codes, limits — are
[auth-api/contract.reseller-users.md](../../interfaces/auth-api/contract.reseller-users.md).

Code: `txnet-backend/auth-service/src/app/auth/users/reseller-users.service.ts`.

## Provides

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| list a reseller's users | the reseller (named in the path), `q?` (3-64, the same matcher as "find a user"), `page`, `pageSize` (1-100), `staff?` (`true`: only people whose role holds any permission — the team, F-1201-c) | `{items, total, page, pageSize}`, newest first; an item is `id, fullName, username, phoneMasked, status, createdAt, canAct, staff, role {id, name}` — never the number, never an email | sync | the door's four; nothing else |
| block one | the reseller, the user's id, `reason?`, the caller's IP | that user at `suspended` (restricted to support, ADR-0133) with `statusReason`, every live session of theirs revoked `admin_ban`, one `admin_audit_log` row `user_ban` under the reseller's `tenantId` | sync (tx) | `user_not_found`, `user_banned`, `cannot_block_self`, `no_authority` |
| unblock one | the same | that user at `active`, `statusReason` cleared, every session revoked, one `admin_audit_log` row `user_unban` | sync (tx) | `user_not_found`, `user_banned`, `cannot_block_self`, `no_authority` |
| read one (AC-1-a) | the reseller, the user's id | the list's item plus `emailMasked` (`a***@example.com`, or null) | sync | `user_not_found` |
| edit one's profile (AC-1-a) | the reseller, the user's id, any of `fullName`, `username`, `email: null`, the caller's IP | the profile as it now stands; one `admin_audit_log` row `user_profile_update` holding only the changed fields, before and after (an address masked) | sync (tx) | `user_not_found`, `user_banned`, `no_authority`, `username_taken` |

## The rules this surface exists to hold

- **The scope is the whole filter.** Admission runs through `ResellerAccess`
  (tenant invariant 21) and the work runs inside
  `runWithTenant(<the reseller>)`, so the app pool's RLS already answers "whose
  users". **No query here names a `tenantId`** — a filter written by hand is a
  filter that can be written wrong, and one reseller reading another's
  customers is the failure this row exists to prevent. A user id from another
  tenant is therefore `user_not_found`, the same answer an id that never
  existed gets.
- **The platform's own users are one more tenant here** (F-311-aa, ADR-0102).
  The path may name the platform's tenant; only platform staff are admitted
  to it (`runIncludingPlatform`), and it is scoped, audited and blocked exactly
  as a reseller's users are. Platform staff are in that list themselves.
- **Platform staff reach a reseller's users only with its consent** (F-117-b,
  ADR-0104 (4)): a live `read` consent lists, an `act` one also blocks; else
  **403** `consent_required` / `consent_read_only`, checked on every request
  by the door ([tenant contract.entitlements.md](../tenant/contract.entitlements.md)).
- **`read` to list, `staffWrite` to block.** So a suspended reseller still sees
  its customers and changes nothing about them (`tenant/rules.md`).
- **`banned` outranks a block.** A reseller moves a user between `active` and
  `suspended` only. The platform's `banned` is neither set nor lifted here, so
  a reseller cannot restore an account the platform closed — a `banned` user is
  refused on both verbs rather than silently left alone.
- **A block is immediate, not eventual.** The next sign-in is the restricted
  one ([contract.blocked-accounts.md](contract.blocked-accounts.md)), which makes
  the status the decision; revoking every session — on the lift too — is what
  makes it take effect now, instead of when the last access token happened to
  expire. The revoke runs **after** the transaction commits: Redis is not
  transactional, and a marker dropped for a write that then rolled back would
  sign out an account nobody blocked.
- **Blocking yourself is refused.** A reseller's staff member is a user of that
  same tenant, so they are in this list; a button that locks the panel behind
  itself is not a decision anybody means to take.
- **Admission is not authority over a person** (F-311-ac, ADR-0103,
  invariant 18). The door says who may administer the tenant; block and
  unblock then ask `authorityOver` (`users/authority.ts`) about the one person
  named: never the tenant's owner, and among peers only a caller holding every
  key the target holds and one more. The owner, and platform staff in a
  reseller's tenant, act on anyone else. The target's keys are read from their
  role at the act; a refusal is `no_authority` and writes nothing.
- **The list is told, not left to guess.** Each row's `canAct` is that rule's
  answer for the caller; `staff` marks a person holding any key, or the owner.
  Staff are listed, not hidden — hiding protects nothing, the server does.
- **Idempotent.** Blocking an already-blocked user changes nothing and writes
  no second audit row: the trail answers "who closed this account", and a
  double-click is not a second closure.
- **Audited to the reseller.** The `admin_audit_log` row carries the
  **reseller's** `tenantId`, not the platform's — the act was taken inside that
  tenant and is read back with it (`audit/contract.md`; the nullable-tenant
  policy in the RLS migration permits the write, and strict reads keep it the
  reseller's).

## A person's profile, edited by staff (AC-1-a)

- **Editing someone is acting on them.** Admitted under `staffWrite`, then
  `authorityOver` about the one person named, exactly as a block: never
  yourself (you edit yourself at `/auth/me`), never the owner, a peer only
  from strictly above. A `banned` account is the platform's and is refused.
- **An email is removed, never written** (user, 2026-10-09). A stored
  address is one its owner proved (invariant 15); one typed by staff is not,
  and campaign mail (F-035-h) would reach it. Removal clears `email` and
  `emailVerifiedAt` together; the person adds a new one themselves. A
  staff-proposed address confirmed by its owner would be its own row.
- **The phone is not editable here.** It is the person's sign-in.
- **A username takes register's rules** — and register's refusals: one held
  in the tenant (the unique index, so two concurrent renames cannot both
  win) or by the tenant's owner across tenants (invariant 16, through
  `SurfaceOwnerService.ownerHoldsUsername`) is `username_taken`.
- **Only what changed is written and audited**; a body that changes nothing
  writes nothing. No session is revoked — nothing here changes what the
  person may do.

## What it does not do

- **No creation.** A reseller's user is created by registering on that
  reseller's domain (F-061-d). An admin-typed account would be a second way for
  a person to exist in a tenant, with no verified phone behind it. If the spec
  turns out to mean an admin-made account, that is its own row.
- **No renewal and no revenue report.** The other two halves of F-311 are
  `billing`'s and `catalog`'s, not identity's.
- **No raw phone number.** The list masks, as "find a user" does. A reseller
  that needs to reach a customer has the notification surfaces for it.
- **No role or permission change.** A person's role is set at
  `PUT …/users/:userId/role` ([contract.roles.md](contract.roles.md)); this
  surface moves a user's `status` and edits their profile.

## Impersonating a reseller's user (F-117-e)

`POST /api/auth/tenants/:tenantId/users/:userId/impersonate` `{reasonNote≥10}`,
`user.impersonate` plus the consent door (ADR-0104 (4)(5), catalog §3.6 layer
6). The same-tenant route (`/api/auth/users/:userId/impersonate`) never reaches
a reseller's user: RLS hides them from the platform's scope.

- **Admitted by `runIncludingPlatform` with capability `staffWrite`**: a live
  `act` consent, or the caller's own emergency entry (tier C). A `read`
  consent is 403 `consent_read_only`; none, 403 `consent_required`. The door
  records the request in the reseller's trail (audit invariant 14). Platform
  staff only — an owner or member is 403.
- **The session ends no later than what admitted it**: its life is the lesser
  of 30 minutes and the time the consent or entry has left; no refresh token.
- **It is tied to it** — `impersonation_session.consentId` /
  `emergencyEntryId` — and `ImpersonationLeash` ends it the moment that ends
  early: a revoke, a grant superseding the consent, the entry ended. The rows
  are marked first, then the Redis markers are dropped, so the next request
  is refused.
- **Never the reseller's owner** (ADR-0137), under consent or emergency alike:
  403. Authority and reason are invariant 7's; the start's audit row is in the
  **reseller's** log (`tenantId`), written in a transaction bound to it.
