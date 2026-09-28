---
id: panel-web
layer: interface
status: active
version: 38
updated: 2026-09-28
---

# Contract — panel-web: a reseller's users and one user's services (F-311-v)

A topic file of [contract.md](contract.md) (§10), and a screen pair of the
reseller workspace described in [contract.resellers.md](contract.resellers.md)
"A reseller's workspace" (ADR-0064 (4)) — its rules 18 and 25 hold here too.
Reached from the console's "More settings" (`OnboardingConsoleView`).

| page | route | files |
|---|---|---|
| its users | `/my-resellers/[id]/users` (`myResellerUsersPath`) | `my-resellers/[id]/users/_components/ResellerUsersView.tsx` |
| one user's services | `/my-resellers/[id]/users/[userId]` (`myResellerUserPath`) | `…/users/[userId]/_components/UserServicesView.tsx`, `AdminConfigs.tsx`, `useUserMessage.ts` |

Rules for both: `my-resellers/_lib/users.ts`. Calls: `resellerUsersApi`
(`lib/auth-api.ts`) over auth's
[contract.reseller-users.md](../auth-api/contract.reseller-users.md) (F-311-a),
and `resellerUserGrantsApi(tenantId, userId)` (`lib/billing-api.ts`) over
billing's [contract.reseller-grants.md](../../domains/billing/contract.reseller-grants.md)
"One user's services" and "An admin's actions on one user's configs" (F-311-f/g).

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | **The reseller and the user are the path's**, in every call: `/auth/tenants/:id/users`, `/billing/tenants/:id/users/:userId/…`. Nothing is built from the session | the owner signs in to the platform's tenant (ADR-0059); an ambient path lists the platform's users, or the admin's own Grants |
| 2 | **No permission is judged here.** `ResellerAccess` admits; a refusal is its sentence (`USER_REFUSAL_KEYS`), which the spec holds to both controllers' `STATUS` maps | invariant 21 is the door's, and a reason with no sentence reaches an owner as a blank line |
| 3 | The list's search is **3–64 characters or none** (`usersQuery`); fewer keep the unfiltered list, with a hint. It is sent after typing rests, from page 1 | the route answers 400 to one or two letters |
| 4 | A row shows name, `@username`, `phoneMasked`, status and joined date — never a phone. **Block is not on this page** | the route answers no phone; block is F-311-a's verb, not yet a panel row |
| 5 | The user's name reaches the services page as `?name=` for its title only; nothing is read by it | there is no read of one user by id, and the title is display |
| 6 | The services page is `/services`' own pieces — `UsageMeter`, `UsageBars` (`read` = the admin's usage route), `ConfigLines` without `onRenamed` (no pencil), `QrDialog`, `GRANT_TONES` — over this user's routes | the admin sees what the user sees; there is no admin label route |
| 7 | The list is billing's `current` scope, "show ended" (`hidden`) switches to `all` — billing filters, never the page | as `/services` (contract.my-services.md) |
| 8 | A Grant's sheet is read **only when opened**: configs, 30-day usage and the `/sub` link — the link on copy / QR only | the three share one bucket, 300/900s per caller |
| 9 | A service is named by its variant's **SKU** | the catalog text namespace the panel reads is the session tenant's, not this reseller's |
| 10 | Config actions offered: **regenerate, disable, enable, retire**, on one config or the ticked ones (1–50). A disable asks its reason first (1–200, the user reads it); `adminActionBody` sends no body the schema would refuse; retire confirms | the schema refuses the whole request for a bad body, not one config |
| 11 | **An outcome per config**: the refused ones are named by the name they had when pressed (`REFUSAL_KEYS`), the list is read again; a thrown request is its sentence and touched nothing | billing answers 200 with one outcome per id |
| 12 | No "n left" gates an admin's regenerate | billing neither checks nor counts it for an admin (network `contract.provisioning.md`) |

**Not covered:** `move` (billing takes it, but a reseller has no read of the
panels it may move to, so the screen would ask for a typed panel id); the
Grant actions — freeze, days, traffic, reset, gift, speed, rotate, delete,
issue (F-311-w); history, search by pasted link, bulk (F-311-x).
