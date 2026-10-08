---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-04
---

# Contract — panel-web: the platform's access to a reseller's people (F-117-f, ADR-0104)

A topic file of [contract.md](contract.md) (§10) and a card of the reseller
workspace in [contract.resellers.md](contract.resellers.md) "A reseller's
workspace" (ADR-0064 (4)), which is at its ceiling. The routes, states and
refusals are audit's: [contract.md](../../domains/audit/contract.md) "Support
consent", "Emergency entry — tier C", "The platform's trail in a reseller".
This is the page over them.

Calls: `supportConsentApi` (`lib/auth-api.ts`) over
`/api/auth/tenants/:id/support-consent`. Rules: `my-resellers/_lib/support-access.ts`;
strings `common.supportAccess` (both sides).

## The reseller's card (F-117-f)

`my-resellers/[id]/_components/SupportAccessCard.tsx`, on the workspace
settings page (`/my-resellers/:id/settings`, `ResellerSettingsView`) under the limit and
package cards. By the path's reseller, never the session's (invariant 21).

| # | Rule | Why |
|---|---|---|
| 1 | **Nothing is judged here.** The list and the trail are asked for the path's reseller; a `reseller_only` refusal of the trail means the visitor is platform staff, and the card renders nothing | the trail is the reseller's (audit invariant 14); staff have their own side on the users pages |
| 2 | Every state is the service's `state` (`consentSides`): one open request, one live grant, the rest as history. No date is compared here to decide a state | a consent's state is derived on read, by one clock |
| 3 | **An open request is answered on terms chosen on the card**: approve sends `{scope, hours, requestId}`; decline revokes it. The scope radio starts at `read` whatever the request asked; hours start at the reseller's `defaultHours` | `act` is a choice, never inherited from the asker |
| 4 | Hours are a whole number 1..24 (`hoursOf`), else the button stays off and the box says why; the same for the default length (`PUT policy`) | `hours_out_of_range` should never be the first a reseller hears of the bound |
| 5 | A live grant shows its scope and **time left, rounded up to the minute** (`timeLeft`), re-read every 30s; past its end it reads "ran out", never "0 minutes" | an access still open must not look closed |
| 6 | **A revoke is asked first** (`window.confirm`); it ends the access on the platform's next request and any impersonation riding on it | it cannot be undone; the platform must ask again |
| 7 | With no request and no live grant, the card offers a grant on its own (`{scope, hours}`) | a reseller may open access before support asks |
| 8 | **Emergency entries are listed apart**, each with its reason, start and state; the reseller cannot end one | tier C is the access that does not ask it (audit "Emergency entry") |
| 9 | The trail lists each request of the platform's staff: its `act` (method and route template, left-to-right), its tier, its time; 50 a page, older / newer | ADR-0104 (6): reads are recorded too |
| 10 | Refusals are `supportRefusalKey`'s sentence — every `SupportConsentRejection` and the door's `consent_required` / `consent_read_only` — else the generic answer | a refusal says what to do next |

Spec: `my-resellers/support-access.test.tsx`.

## The platform's side (F-117-g)

`my-resellers/_components/PlatformAccessBanner.tsx` (`PlatformAccessBanner`,
`ConsentNeeded`), at the top of both users pages
([contract.reseller-users.md](contract.reseller-users.md)).

| # | Rule | Why |
|---|---|---|
| 11 | **Only platform staff see the banner** (`staffVisitor`): a session on the platform, on a reseller's page, not its owner (`ownedResellers`). The platform's own users and the reseller's people see nothing. A hint only — the door still decides | the door admits those without a consent (tenant `contract.entitlements.md`) |
| 12 | It shows the live consent's scope and time left (rule 5), an open request as "waiting for the reseller" with **withdraw**, or "no access, ask the reseller" | the platform asks, the reseller grants: no grant here |
| 13 | **A request needs a reason of 10 characters after a trim** (`reasonOf`), sent trimmed with the scope chosen (default `read`); with a live `read` consent the form stays, so staff can ask for `act` | `requestConsentSchema`; a write under `read` is `consent_read_only` |
| 14 | **Emergency entry is offered only to a holder of `tenant.emergency_access`** (`holdsPermission`), needs 20 characters, and is **asked first**. The caller's own running entry shows its time left and **end**; no second entry is offered while it runs | the owner is told at once and the hour is never extended (audit "Emergency entry") |
| 15 | After any act the banner and the page under it are read again (`onChange`) | a consent opens the list without a reload |
| 16 | **A users page refused for want of consent says what to do, not "failed"**: `consent_required` / `consent_read_only` on the list or a user's services render `ConsentNeeded` (a status, no retry); on an action they are the users pages' own sentences (`USER_REFUSAL_KEYS`, `useUserMessage`) | the row: "the refusal as 'ask the reseller', not an error" |

Spec: `my-resellers/platform-access.test.tsx`.
