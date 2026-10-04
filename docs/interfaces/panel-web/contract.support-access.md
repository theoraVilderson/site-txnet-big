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
console (`/my-resellers/:id`, `OnboardingConsoleView`) under the limit and
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
