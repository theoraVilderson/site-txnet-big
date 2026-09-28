---
id: panel-web
layer: interface
status: active
version: 39
updated: 2026-09-28
---

# Contract — panel-web: the operating currency (F-116-h) and a manual rate (F-116-l)

A topic file of [contract.resellers.md](contract.resellers.md). One card,
`(panel)/_components/OperatingCurrencyCard.tsx`, over tenant's two routes
([tenant/contract.currency.md](../../domains/tenant/contract.currency.md)),
through `operatingCurrencyApi` in `src/lib/tenant-api.ts`. It picks the
currency; every other screen shows money in the currency its answer names
([contract.kit.md](contract.kit.md) rule 1a, F-116-h3, ADR-0098).

## Where it is

| Place | Whose currency | Shown to |
|---|---|---|
| `/my-resellers/:id`, under "more" | the path's reseller (`scope="reseller"`) | anyone who opens the workspace; tenant-service admits by the path (invariant 21) and the card shows its refusal otherwise |
| `/settings`, last section | the platform's own tenant (`scope="platform"`) | a caller signed in to the `platform_owner` tenant **and** holding `tenant.manage` or `*` (SuperAdmin; the service honours it too — `canSetPlatformCurrency`) — a reseller can grant itself either key, so the type gates it too |

A reseller's currency is never on `/settings`: its owner's session carries
the platform tenant on either domain (invariant 21), so `me.tenant` there is
the platform's, not the reseller's.

## Rules

1. **A change is never one click.** The picker enables "change" only for a
   code other than the current one; the `PUT` is sent only after a confirm
   that names both currencies and says what converts (live money) and what
   does not (history; unpaid invoices are cancelled). On the platform the
   confirm adds that every reseller's billing wallet and package converts
   too (tenant rule 3).
2. **What was converted is the answer's.** After a change the card shows
   `conversion.rate` as `1 <from> = <rate> <to>` and one line per summary
   kind with a count above zero; all zero reads "there was no money to
   convert". `conversion: null` (rule 4, already that code) shows nothing.
3. **Every refusal has its own sentence** (`common.operatingCurrency.refusals.*`),
   the route's seven: invariant 21's four, `currency_unavailable`,
   `rate_unavailable`, `currency_changed`. Anything else is
   `useApiErrorMessage`'s.
4. **`currency_changed` re-reads.** Another admin changed it first; the card
   shows the refusal and reloads the current code and choices, and never
   resends the pick on its own.
5. **The choices are the route's.** The panel lists `choices` as answered
   (`name (CODE)`); it never keeps its own list of currencies.

Spec: `OperatingCurrencyCard.test.tsx`.

## The manual-rate card (F-116-l)

`(panel)/_components/ManualRateCard.tsx`, over currency-service's `GET
/rates` and the three pin routes
([currency/contract.md](../../domains/currency/contract.md) "HTTP API"),
through `currencyApi` in `src/lib/currency-api.ts`.

| Place | Whose books | Shown to |
|---|---|---|
| `/settings`, after the operating-currency card | the session's tenant: the platform's on its domain (`scope="platform"`), a reseller's on the reseller's own domain (`scope="reseller"`) | a caller holding `currency.pin` or `*` (`canPinRates`); no tenant-type gate — the service scopes the pin |

**Not in the workspace.** The pin routes take no tenant: they pin for the
session's. A reseller owner's session in `/my-resellers/:id` is the
platform's (invariant 21), so a card there would pin the platform's rate.

6. **Any currency but the base.** The picker is `GET /rates` minus
   `isBase` (user, 2026-09-28: "each currency by hand"); a currency a
   reseller's books do not use is refused by the service
   (`currency_not_yours`) and shown in its own sentence, never pre-filtered here.
7. **The reading is a suggestion, never a rate** (D-53). The rate box starts
   empty. `lastDownload.rate`, when it differs from `lastAccepted`, is a
   button that fills the box; nothing fills it on its own.
8. **A pin is never one click.** "Set" is enabled for a positive decimal
   (the route's pattern), a reason of 3+ characters and 1–720 hours, and it
   opens a confirm naming `1 USD = <rate> <code>` and the hours; the platform's
   adds that every reseller without its own pin follows it.
9. **What is live is the answer's.** After a pin or an end the form is read
   again; the card never patches it from what it sent. A tenant sees the
   platform's live pin beside its own (`platformPin`), and ends only its own.
10. **Every refusal has its own sentence** (`common.manualRate.refusals.*`),
    the routes' seven; anything else is `useApiErrorMessage`'s.

Spec: `ManualRateCard.test.tsx`, `settings/_lib/settings.test.ts`.
