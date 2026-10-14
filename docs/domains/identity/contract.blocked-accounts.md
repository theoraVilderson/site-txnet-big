---
id: identity
layer: domain
status: active
version: 25
updated: 2026-10-08
---

# Contract — identity / a blocked account

A topic file of [contract.md](contract.md) (§10), opened because that file is at
its 250-line cap. What `identity.user.status` means for the person and who may
change it (BAN-1, [ADR-0133](../../architecture/decisions/0133-a-blocked-account-is-restricted-to-support-or-banned-and-told-why.md)).
Routes and shapes: [auth-api/contract.blocked-accounts.md](../../interfaces/auth-api/contract.blocked-accounts.md).

Code: `txnet-backend/auth-service/src/app/auth/users/user-status.service.ts`,
`auth.service.ts` (`mayHoldSession`, `bannedAnswer`), `token.service.ts`, `auth.guard.ts`.

## The two levels

| status | sign-in | the token | what the person sees |
|---|---|---|---|
| `active` | yes | whole | everything their role allows |
| `suspended` — **restricted** | yes, every path (password, code, two-factor, messenger, switch, add-account, reset) | `restricted: true`, `permissions: []`, `permHash` still the role's | the reason and their own support conversations; `me`, the switcher, sign-out |
| `banned` | never | — | at sign-in, `auth.accountBanned` with the reason, **only after the password or code checked out** |

`statusReason` is what staff wrote, shown verbatim; `statusChangedAt` when.
Who acted is the `admin_audit_log` row (`user_ban` / `user_unban`, `reason`).

## Rules

1. **Restriction is enforced where tokens are checked, never in a page.**
   `auth-handler` admits a restricted token only on its allow-list
   ([forward-auth/contract.md](../../platform/forward-auth/contract.md) "A restricted
   token"); auth-service's `AuthGuard` admits one only on a handler marked
   `@AllowRestricted()` — `GET /auth/me`, `/auth/me/timezone`,
   `/auth/me/ui-preferences`, `/auth/accounts/*`. Unmarked is refused, so a
   new route fails closed.
2. **Anything but `active` mints the restricted token.** `signAccessToken`
   reads `status !== 'active'`, so a caller that loaded a user without its
   status gets the narrow token, never the whole one.
3. **A ban is told only after a proof** (invariant 19). Before it, the answer
   is the ordinary `invalidCredentials` / `invalidOtp`; a login code *is* sent
   to a banned number so its owner can learn why.
4. **Every status change revokes every session**, after the transaction
   commits — restricting, banning and lifting alike. The next sign-in is the
   restricted, the refused or the whole one; no token outlives the change.
5. **Two keys.** `restriction.assign` (the Support and Admin presets)
   restricts and lifts a restriction; `user.ban` (the Admin preset) is needed whenever
   `banned` is on either side of the change.
6. **Staff act in their own tenant, on someone below them.** The gate's tenant
   must be the caller's; ADR-0103's authority rule is asked over the target's
   staff keys — a customer's `self.*` keys are left out, or no agent would be
   above any customer. Never on oneself, never on the tenant's owner.
7. **A block needs a reason; a lift needs none.** A blank reason is
   `reason_required`; a lift clears `statusReason`.
8. **A reseller's block is the restricted level** (F-311-a, F-311-c), with an
   optional reason. It still neither sets nor lifts `banned`.
