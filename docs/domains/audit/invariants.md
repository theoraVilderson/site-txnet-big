---
id: audit
layer: domain
status: draft
updated: 2026-09-06
---

# Invariants — audit

#1–#3 and #5 were extracted from schema comments; #4, #6 and #7 were decided for
account switching (catalog 2.8, C-21/C-22) on 2026-09-06. **#3, #4, #6, #7 and
#8 are enforced in code** as of F-0205 / F-0206 / F-0207 / F-0208. #1, #2 and
#5 remain unenforced here — impersonation is written by identity.

**#3 was rewritten on 2026-09-06 by ADR-0015**, which made a group belong to
the surface it was built on rather than to the person. #4, #6 and #7 are
unchanged by it — deliberately, and that is the argument for the shape chosen:
see the ADR on why the *member row* carries the scope and not the group.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `admin_audit_log` rows are never updated or deleted by anyone | planned service layer / schema | see contract | 
| 2 | Every impersonation start and end writes an `admin_audit_log` row in the same transaction as the state change (already enforced in `auth-service`) | planned service layer / schema | see contract | 
| 3 | A user belongs to at most one `linked_account_group` **per switch scope** (`@@unique([scopeKey, userId])`, ADR-0015). Joining is still a **move**, but only *within* a scope: an account already in another group **on this surface** is refused rather than reassigned — leaving is the other side's call (F-0208). A group it holds in a different scope is no obstacle and is not visible from here | `AccountSwitchService.join` + schema | see contract | 
| 4 | An account joins a switch group only after **that account** proves itself: an OTP to its own phone, its own password, or — for the founder — the live session the request arrives on, which was itself minted by one of those. A member row is never written without one of the three. `verifiedViaOtp` records only *whether the proof was an OTP*; it never means "unproved" | `AccountSwitchService.join` (F-0205) | a stranger's account attached to someone else's switcher — a silent, permanent takeover |
| 5 | `reasonNote` on an impersonation session is mandatory and >= 10 chars | planned service layer / schema | see contract |
| 6 | A switch never crosses `tenantId`: membership may span tenants (it records a human), but the list and the switch itself only ever offer members of the caller's own tenant (C-22) | `AccountSwitchService.list` (tenant-filtered query) + `.switchTo` (F-0206/F-0207) | a session for brand B handed to a page served on brand A's domain |
| 7 | Switching revokes the outgoing session in the same transaction that issues the incoming one (C-21). One browser holds exactly one live session at every instant, which is what keeps F-0101's "one device, one account" true | `AuthService.switchSession` — one `$transaction`, and the Redis marker order below | an orphaned live session the user cannot see or end; F-0101 becomes a lie |
| 8 | Every member row of one `groupId` shares one `scopeKey`, and a group is never left with fewer than two members (ADR-0015). A group split across scopes would be readable from one surface and half-readable from another; a group of one is not a switcher | `AccountSwitchService.join` (inherits the founder row's scope) and `.remove` (tears the group down at one member) | a switcher that lists members it cannot switch to, on a surface that never proved them |

## How to test

3, 4. `account-switch.service.spec.ts`: a first add creates the group with
   **both** the founder and the joiner; an account already in another group is
   refused and nothing is written; a failed proof answers one key and writes
   nothing.

6. `account-switch.service.spec.ts`: a member of another tenant is absent from
   the list, and switching to it is refused with the same key as a
   non-member — the two halves of C-22, and they have to be asserted
   separately because hiding a member is not the same as refusing it.

7. Same file: a switch calls identity's handover exactly once, with the session
   the request arrived on. **The ordering is the part a test cannot see**, so
   it is stated here: the transaction revokes the outgoing row and writes the
   incoming one together, then the outgoing Redis marker is dropped, and only
   then is the incoming marker written. `AuthGuard` reads the marker alone, so
   that order leaves a window with *no* usable session and never one with two.
   Writing the incoming marker first would invert exactly that.

3, 8. Same file: two scopes cannot see each other's group (`list` from the chat
   is empty while the browser's is full), and an account already in a group in
   *another* scope is added here without complaint — the case that would have
   been refused before ADR-0015.

8 (removal side). `remove` from either side drops only the `(scopeKey, userId)`
   row, revokes only that scope's sessions
   (`revokeSessionsForUserInScope`, never `revokeAllSessionsForUser` — the
   assertion is written negatively on purpose, because the wide call sits right
   next to the narrow one), and deletes the group once one member would be
   left.
