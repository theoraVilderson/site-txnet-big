---
id: identity
layer: domain
status: active
version: 23
updated: 2026-09-20
---

# Contract — identity / a reseller's own users

A topic file of [contract.md](contract.md) (§10), opened because that file is at
its 250-line cap. What a reseller may know and decide about the people who
registered on its domain (F-311-a, spec F-311): read a page of them, block one,
lift the block. Wire shapes — paths, codes, limits — are
[auth-api/contract.reseller-users.md](../../interfaces/auth-api/contract.reseller-users.md).

Code: `txnet-backend/auth-service/src/app/auth/users/reseller-users.service.ts`.

## Provides

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| list a reseller's users | the reseller (named in the path), `q?` (3-64, the same matcher as "find a user"), `page`, `pageSize` (1-100) | `{items, total, page, pageSize}`, newest first; an item is `id, fullName, username, phoneMasked, status, createdAt` — never the number, never an email | sync | the door's four; nothing else |
| block one | the reseller, the user's id, the caller's IP | that user at `suspended`, every live session of theirs revoked `admin_ban`, one `admin_audit_log` row `user_ban` under the reseller's `tenantId` | sync (tx) | `user_not_found`, `user_banned`, `cannot_block_self` |
| unblock one | the same | that user at `active`, one `admin_audit_log` row `user_unban` | sync (tx) | `user_not_found`, `user_banned` |

## The rules this surface exists to hold

- **The scope is the whole filter.** Admission runs through `ResellerAccess`
  (tenant invariant 21) and the work runs inside
  `runWithTenant(<the reseller>)`, so the app pool's RLS already answers "whose
  users". **No query here names a `tenantId`** — a filter written by hand is a
  filter that can be written wrong, and one reseller reading another's
  customers is the failure this row exists to prevent. A user id from another
  tenant is therefore `user_not_found`, the same answer an id that never
  existed gets.
- **`read` to list, `staffWrite` to block.** So a suspended reseller still sees
  its customers and changes nothing about them (`tenant/rules.md`).
- **`banned` outranks a block.** A reseller moves a user between `active` and
  `suspended` only. The platform's `banned` is neither set nor lifted here, so
  a reseller cannot restore an account the platform closed — a `banned` user is
  refused on both verbs rather than silently left alone.
- **A block is immediate, not eventual.** Sign-in already refuses anything but
  `active`, which makes the status the decision; revoking every session is what
  makes it take effect now, instead of when the last access token happened to
  expire. The revoke runs **after** the transaction commits: Redis is not
  transactional, and a marker dropped for a write that then rolled back would
  sign out an account nobody blocked.
- **Blocking yourself is refused.** A reseller's staff member is a user of that
  same tenant, so they are in this list; a button that locks the panel behind
  itself is not a decision anybody means to take.
- **Idempotent.** Blocking an already-blocked user changes nothing and writes
  no second audit row: the trail answers "who closed this account", and a
  double-click is not a second closure.
- **Audited to the reseller.** The `admin_audit_log` row carries the
  **reseller's** `tenantId`, not the platform's — the act was taken inside that
  tenant and is read back with it (`audit/contract.md`; the nullable-tenant
  policy in the RLS migration permits the write, and strict reads keep it the
  reseller's).

## What it does not do

- **No creation.** A reseller's user is created by registering on that
  reseller's domain (F-061-d). An admin-typed account would be a second way for
  a person to exist in a tenant, with no verified phone behind it. If the spec
  turns out to mean an admin-made account, that is its own row.
- **No renewal and no revenue report.** The other two halves of F-311 are
  `billing`'s and `catalog`'s, not identity's.
- **No raw phone number.** The list masks, as "find a user" does. A reseller
  that needs to reach a customer has the notification surfaces for it.
- **No role or permission change.** A reseller administers its roles at
  `/auth/roles` ([contract.roles.md](contract.roles.md)); this surface only
  moves a user's `status`.
