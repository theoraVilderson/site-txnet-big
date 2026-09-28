---
id: panel-web
layer: interface
status: active
version: 38
updated: 2026-09-28
---

# Contract — panel-web: a reseller's users and one user's services (F-311-v, -w, -x, -x1)

A topic file of [contract.md](contract.md) (§10), and a screen pair of the
reseller workspace described in [contract.resellers.md](contract.resellers.md)
"A reseller's workspace" (ADR-0064 (4)) — its rules 18 and 25 hold here too.
Reached from the console's "More settings" (`OnboardingConsoleView`).

| page | route | files |
|---|---|---|
| its users | `/my-resellers/[id]/users` (`myResellerUsersPath`) | `my-resellers/[id]/users/_components/ResellerUsersView.tsx`, `FindByLink.tsx`, `BulkByFilter.tsx` |
| one user's services | `/my-resellers/[id]/users/[userId]` (`myResellerUserPath`) | `…/users/[userId]/_components/UserServicesView.tsx`, `AdminConfigs.tsx`, `GrantActions.tsx`, `GrantHistory.tsx`, `useUserMessage.ts` |

Rules for both: `my-resellers/_lib/users.ts`; a Grant's acts: `my-resellers/_lib/grant-actions.ts`; search, bulk and history: `my-resellers/_lib/grant-bulk.ts`. Calls: `resellerUsersApi`
(`lib/auth-api.ts`) over auth's
[contract.reseller-users.md](../auth-api/contract.reseller-users.md) (F-311-a),
and `resellerUserGrantsApi(tenantId, userId)` (`lib/billing-api.ts`) over
billing's [contract.reseller-grants.md](../../domains/billing/contract.reseller-grants.md)
"One user's services", "An admin's actions on one user's configs" (F-311-f/g) and
its Grant sections (F-311-d, -h..-q); across users, `resellerGrantsApi(tenantId)`
over its "by a pasted line" (F-311-t) and [contract.reseller-grants-bulk.md](../../domains/billing/contract.reseller-grants-bulk.md) (F-311-u, -u1; its jobs and `panels`, F-311-u2/-u3/-x1).

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | **The reseller and the user are the path's**, in every call: `/auth/tenants/:id/users`, `/billing/tenants/:id/users/:userId/…`. Nothing is built from the session | the owner signs in to the platform's tenant (ADR-0059); an ambient path lists the platform's users, or the admin's own Grants |
| 2 | **No permission is judged here.** `ResellerAccess` admits; a refusal is its sentence (`USER_REFUSAL_KEYS`), which the spec holds to both controllers' `STATUS` maps | invariant 21 is the door's, and a reason with no sentence reaches an owner as a blank line |
| 3 | The list's search is **3–64 characters or none** (`usersQuery`); fewer keep the unfiltered list, with a hint. It is sent after typing rests, from page 1 | the route answers 400 to one or two letters |
| 4 | A row shows name, `@username`, `phoneMasked`, status and joined date — never a phone. **Block / unblock** (F-311-v4, `blockActionOf`): block on `active`, unblock on `suspended`, confirmed first; the row takes the user auth answers. A `banned` user gets no button | the route answers no phone; a block signs the user out everywhere; a reseller neither deepens nor lifts a platform ban |
| 5 | The user's name reaches the services page as `?name=` for its title only; nothing is read by it | there is no read of one user by id, and the title is display |
| 6 | The services page is `/services`' own pieces — `UsageMeter`, `UsageBars` (`read` = the admin's usage route), `ConfigLines` without `onRenamed` (no pencil), `QrDialog`, `GRANT_TONES` — over this user's routes | the admin sees what the user sees; there is no admin label route |
| 7 | The list is billing's `current` scope, "show ended" (`hidden`) switches to `all` — billing filters, never the page | as `/services` (contract.my-services.md) |
| 8 | A Grant's sheet is read **only when opened**: configs, 30-day usage and the `/sub` link — the link on copy / QR only | the three share one bucket, 300/900s per caller |
| 9 | A service is named as on `/services`: its catalog text (`catalogApi.texts`, read once per page), the SKU when there is none (F-311-v3) | a reseller's items are named in the same published `catalog` namespace |
| 10 | Config actions offered: **regenerate, disable, enable, retire, move**, on one config or the ticked ones (1–50). A disable asks its reason first (1–200, the user reads it); a move its panel from billing's `configs/move-targets` (F-311-v1), read the first time move is pressed (F-311-v2); `adminActionBody` sends no body the schema would refuse; retire confirms | the schema refuses the whole request for a bad body, not one config |
| 11 | **An outcome per config**: the refused ones are named by the name they had when pressed (`ADMIN_REFUSAL_KEYS` — the owner's, plus a move's `same_panel` / `panel_not_found`), the list is read again; a thrown request is its sentence and touched nothing | billing answers 200 with one outcome per id |
| 12 | No "n left" gates an admin's regenerate | billing neither checks nor counts it for an admin (network `contract.provisioning.md`) |
| 13 | **A Grant's acts on its sheet** (F-311-w, `GrantActions`): freeze / unfreeze, days, traffic, reset, gift, speed, devices, new `/sub` link, renew, delete. `grantActionsOf`: every act but the link only on `active` / `suspended`; traffic and reset on a limited prepaid bag, gift on a metered one, days on one with an end. Anything subtler is billing's to refuse | the link is reset in any state; the rest is refused `grant_closed` / `grant_not_renewable` |
| 14 | **The form is the confirm**: one form open, saying what the act does; its button is off until `grantActionBody` returns the exact body its `.strict()` schema takes — a reason where required (1–500), a whole non-zero ±days, a non-zero GB, an empty speed / devices box lifts the cap. A delete's refund is answered either way first | a refused body is a 400 and nothing is done; the refund is the admin's answer (user, 2026-09-26) |
| 15 | A renewal and an issue carry one `requestId` per opened form | a double click renews or issues once (billing answers `renewed` / `issued: false`) |
| 16 | **Issue a new service** on the page (`IssueGrant`): a variant of the reseller's own catalog (`catalogAdminApi(id)`: active products, then each one's active variants), read when the form first opens | billing takes `admin_only` variants too, and refuses what it cannot place (`variant_not_deliverable`) |
| 17 | A Grant act's refusal is its sentence (`GRANT_REFUSAL_KEYS`), which the spec holds to the controller's `GRANT_ACTION_STATUS` and the speed cap's two; the outcome is billing's answer (new end, bag, refund, the new link); after any act the list and the sheet are read again, the `/sub` box re-mounted | those reasons carry no i18n key; a link read before a rotate is dead |
| 18 | **Find by a pasted link** (F-311-x, `FindByLink` on the users page): the paste split as `/services` splits it (`pastedLines`, ≤20, a POST body), billing's `current` scope; each found service names its user's sheet | support is handed a link, not a phone; a line is a credential, never in a URL |
| 19 | **Bulk over the ticked found services** (≤50, `toggleTicked`): the Grant forms' own fields, a reason **always** (`bulkBody`, `grantBulkSchema`), no delete / renew / issue / link; one `requestId` per opened form; an outcome per Grant, a refusal named with its sentence (`bulkRefusalKey`, `grant_not_found` and `failed` the bulk's own); the ticks stay, the search is read again | a bad body refuses every Grant; a repeat answers the first call's outcomes (F-311-u1), so +3 days clicked twice is +3 |
| 20 | **A Grant's history on its sheet** (`GrantHistory`): read when opened and after an act, newest first, 20 a page — the act (`historyActionKey`, a later one a plain label), whether on a config, when, a short actor id, the reason. No IP | billing answers none (audit `contract.md`); the spec holds the labels to `grant-audit.ts`'s two unions |
| 21 | **Bulk by a filter, as a job** (F-311-x1, `BulkByFilter` on the users page): the same acts and fields as rule 19, over every active service, a panel (billing's `bulk-jobs/panels`, read when picked, retired ones marked), or a product / one of its plans (`catalogAdminApi(id)`, switched-off ones included). `filterOf` sends the statuses the act reaches — `suspended` for unfreeze, `active` otherwise. The form shows billing's **count for this pick and this form** (re-counted per opened form), and the start is off while it is 0 or over 100 000; `bulkJobBody` is the bulk body with `filter` for `grantIds`, one `requestId` per form | the selection is frozen at the confirm, so the number shown is the number acted on; a double click answers the same job (F-311-u2) |
| 22 | **The jobs, newest first, 10 a page**: act, filter, status, a progress bar over the frozen `total` (`jobPercent`), ok / refused / failed; read again every `JOB_POLL_MS` (10s) **only while one on the page runs** — the reads share one 300/900s bucket. A running job's **stop** is confirmed (what was done stands); **show refused** reads `outcomes?problems=true`, 20 a page, each with its sentence (`bulkRefusalKey`) and a short id, and says so once billing purged them. A job route's refusal is its sentence (`JOB_REFUSAL_KEYS`, held to the controller's `STATUS`) | an outage job of 8 000 services must be watchable and stoppable without costing the page its other reads |

**Not covered:** re-dating to a picked day (billing takes `endsAt`; the sheet
sends ±days), the panels a speed cap's refusal names (not flat, so not in
the envelope's `facts`), an actor's name in the history (no read of an admin
by id; a short id is shown), and a job's refused service by name (its outcome has no user; a short id is shown).
