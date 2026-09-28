---
id: panel-web
layer: interface
status: active
version: 39
updated: 2026-09-28
---

# Contract — panel-web: picking the operating currency (F-116-h)

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
| `/settings`, last section | the platform's own tenant (`scope="platform"`) | a caller signed in to the `platform_owner` tenant **and** holding `tenant.manage` — a reseller can grant itself the key, so the type gates it too |

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
