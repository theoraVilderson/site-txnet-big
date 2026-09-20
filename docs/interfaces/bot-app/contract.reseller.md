---
id: bot-app
layer: interface
status: active
version: 12
updated: 2026-09-20
---

# Contract — bot-app / the reseller panel in the chat

A topic file of [contract.md](contract.md), opened because that file is at its
250-line cap. The reseller management panel inside the bot (F-311-c, spec
F-311): the menu row, the customer list with search, block / unblock, and the
revenue figure. **Flow only** — every fact on these screens belongs to another
unit, which is what `contract.md` "the decision belongs to" requires.

Code: `bot-service/src/app/flows/reseller.flow.ts`, the screens in
`flows/views.ts`, the door in `tenant-api/tenant-api.client.ts`; tests
`reseller.flow.spec.ts` (the flow) and `conversation/router.spec.ts` (the row).

## Where each fact comes from

| on screen | whose answer | route |
|---|---|---|
| may this chat see the panel at all | tenant, F-311-e | `GET /api/tenants/:id/access` |
| the customers, and the two writes | auth-api, F-311-a | `GET/POST/DELETE /api/auth/tenants/:tenantId/users…` |
| what the reseller earned | billing, F-311-b | `GET /api/billing/tenants/:tenantId/revenue` |

## The reseller is the **bot's**, never the session's

`ctx.integration.tenantId` — the tenant whose webhook path the update arrived
on (F-320) — is what every call above names in its path. It cannot come from
the session: a reseller's owner signs in in their own platform tenant
(ADR-0059 (6), F-061-i), so neither `/auth/me` nor the session names the
reseller whose bot this is. That gap is the whole reason F-311-e exists, and it
was split out of this row rather than worked around here.

## The menu row

| rule | why |
|---|---|
| The row is drawn only where `canRead` is true, asked on the same token the member menu was decided with | this bot serves the reseller's **customers** too, and they are most of the chats that reach that line. A row in front of every customer is the panel's precedent (`tenant/contract.resellers.md` rule 18) being wrong in a chat |
| The verdict is never cached — one call per menu render | ADR-0033's reasoning: a seat revoked a second ago must stop administering, and a remembered "yes" is a row that fails on its first tap |
| A refusal, an unreachable `tenant-service`, or an unset `TENANT_API_BASE_URL` all mean **no row**, never an error | a customer's menu must not break because the tenant API is down |
| Two rejected alternatives, recorded because they will be proposed again: probing a data route (`…/users?pageSize=1`) reads "may I" out of "give me", so a later permission split silently changes the answer; showing the row to everyone puts it in front of every customer | — |

`TENANT_API_BASE_URL` is the gate (`api.<domain>`), never `tenant-service`
directly: that route reads the identity headers `my-auth` writes, exactly as
`BILLING_API_BASE_URL` does for F-306-a.

## The customer list

| rule | why |
|---|---|
| **Typing is the search box.** Free text on this screen is `q`; a tap is a customer | a chat has no other one. Anywhere else in the flow, free text is an answer to a screen that asked nothing |
| Under three characters is refused here, without a call | `q` is three characters or nothing (`auth-api/contract.reseller-users.md`) — a single letter is a dump of the tenant wearing a search box |
| "Nobody has signed up" and "nothing matches *that*" are different screens | answering the second with the first reads as the list having been lost |
| The page rides on the button (`rpage:<n>`); the search is what the state keeps | a chat holds two screens at once routinely, and a page read from remembered state means an older keyboard paging the newer screen. The search is kept so paging stays inside it |
| A customer is opened by **re-listing the remembered page** and finding the row — never from the button's id | a payload is input, not a fact. It also gives the screen a status that is current rather than the one the list was drawn with, and an id that was never on that page (another tenant's included) simply matches nothing. `auth-api` has no read-one-user route and must not grow one for this: that would be a second, narrower door onto the same data |

## Blocking

| rule | why |
|---|---|
| `canWrite` decides whether the button is drawn, re-read for that screen | a suspended reseller still reads its customers and no longer writes (`tenant/rules.md`); deciding the second verdict from the first would copy the status matrix out of the door |
| A `banned` account gets no button at all | the platform banned it, and a reseller neither deepens nor lifts that (`user_banned`, 409) |
| Block asks first, on its own screen, and the confirming tap must name the same customer the state does | blocking signs that account out everywhere, and the tap that causes it sits on the screen someone opened to *look* at a customer. Same two-prefix shape as `drop:` in [contract.accounts.md](contract.accounts.md) |
| Unblock is one tap, and a `DELETE` | giving access back needs no confirmation, and unblock is the **deletion of the block**, not a second verb on the user |
| Every refusal is `auth-api`'s own sentence, rendered `raw` | the bot writes no rule of its own about who may block whom (ADR-0009) |

## The revenue figure

Two figures, labelled, never added: `sales` is what this reseller's customers
spent on its services and `topUps` what they paid in — ADR-0067 decision 1, and
`billing/contract.revenue.md` is the arithmetic. Billing's own default window
is used and its echoed `from`/`to` are rendered, so the bot picks no period.

**`sales` is `0.00` until `entitlement` is built.** The screen therefore names
both figures rather than summing them: a zero labelled "revenue" reads as a
broken report, "service sales" beside "customer top-ups" reads as what it is.

Money is billing's decimal strings, rendered as they arrived — the bot does no
arithmetic on any of it (C-02). Dates are cut to their day part; that is
spelling, not formatting, and `i18n` still owns the calendar and the numerals.

## Not here

Creating a user and renewing one (the other half of F-311) wait on
`entitlement`, as F-311-d does. F-312 (sub-resellers) and F-1531 (the business
summary) read the same verdict this file's menu row turns on.
