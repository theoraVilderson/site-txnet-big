---
id: bot-app
layer: interface
status: active
version: 17
updated: 2026-10-15
---

# Contract — bot-app: My services in the chat (F-307-y)

A topic file of [contract.md](contract.md). `flows/services.flow.ts`, the
`🛡 My services` row on the member menu (`ACTIONS.services`), and
`BillingApiClient.myServices` — the panel's own `GET /api/billing/gift/grants`
through the gate (ADR-0009; billing [contract.gift.md](../../domains/billing/contract.gift.md)
"A user's own Grants, listed"). The panel's side is panel-web
[contract.my-services.md](../panel-web/contract.my-services.md).

## Rules

1. **The bot decides nothing.** Which services a user has and what state each
   is in are billing's list; the screens show it.
2. **The row is first on the member menu, behind billing's reachability**
   (`BillingApiClient.isConfigured`), as the top-up's. No service is `services.none`.
3. **List, then a service.** The list is billing's `current` scope, at most 10
   (`LIST_MAX`), one button each — `name · status` — and says how many more the
   app holds (`services.more`). A service's screen: name, status, traffic,
   time, and the way back to the list.
4. **A service is named as My services and every notice name it** (F-307-x):
   the buyer's `label`, else the catalog `nameKey` from the `catalog`
   namespace in the chat's language, else the default language, else the
   sku, else `services.unnamed` — never a raw key.
5. **Every `GrantStatus` has a word** (`SERVICE_STATUS_KEYS`, held to the
   Prisma enum by the spec); a `frozen` row reads `services.frozen`, not
   "suspended".
6. **Traffic by the Grant's kind**: unlimited, metered (pay as you go), capped
   (`trafficCapBytes`), else used alone — bytes as the notices say them
   (`remainingLabel`), `0 MB` when nothing is used. **Time as whole days
   left**, a span that needs no time zone; under a day, ended, or no end date
   each have their own sentence.
7. **Every button names its service** (`svc:<kind>:<id>`, 42 bytes, under the
   64-byte callback cap) and needs no state: a tap on an old screen still
   means what it says. The router sends the prefix to the flow from any
   state; an unknown kind opens the list.
8. **A service's screen reads billing's list again** (page of 100, the
   route's maximum — there is no single-Grant route); one no longer listed is
   `services.gone`, with the way back.

## Proof

`flows/services.flow.spec.ts` — the list's buttons, names and statuses; a
frozen row; the name's fallbacks to a plain word; how many more; none; a
refusal in billing's words; a service's status, traffic, days left and way
back; unlimited, metered, ended, under a day and no end date; a service gone;
an unknown button; every `GrantStatus`; the callback length.
`locale/bot-copy.spec.ts` holds the new keys in `en`, `fa` and the fallbacks.

## Not covered

The subscription link and its reset, a service's configs, its name and its
notice level are the panel's (the Mini App row). What may be done to a
service from its screen is each riding row's: the user's own freeze is
F-0401-g, a server change F-410-e.
