---
id: bot-app
layer: interface
status: active
version: 13
updated: 2026-09-20
---

# Contract — bot-app / the reseller panel in the chat

A topic file of [contract.md](contract.md), opened because that file is at its
250-line cap. The reseller management panel inside the bot (F-311-c, spec
F-311): the menu row, the customer list with search, block / unblock, the
revenue figure — and the bulk message it sends its customers (F-313-b, spec
F-313). **Flow only** — every fact on these screens belongs to another unit,
which is what `contract.md` "the decision belongs to" requires.

Code: `bot-service/src/app/flows/reseller.flow.ts` and
`flows/reseller-campaign.flow.ts`, the screens in `flows/views.ts`, the two
doors in `tenant-api/tenant-api.client.ts` and
`notification-api/notification-api.client.ts`; tests `reseller.flow.spec.ts`,
`reseller-campaign.flow.spec.ts` and `conversation/router.spec.ts` (the row).

## Where each fact comes from

| on screen | whose answer | route |
|---|---|---|
| may this chat see the panel at all | tenant, F-311-e | `GET /api/tenants/:id/access` |
| the customers, and the two writes | auth-api, F-311-a | `GET/POST/DELETE /api/auth/tenants/:tenantId/users…` |
| what the reseller earned | billing, F-311-b | `GET /api/billing/tenants/:tenantId/revenue` |
| the bulk message: its audience, its size, its draft and its send | notification, F-313-d | `…/notifications/tenants/:tenantId/campaigns…` |

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

## The bulk message (F-313-b)

Pick a segment, see how many it reaches, write it, confirm, watch it go —
`flows/reseller-campaign.flow.ts`, a flow of its own (`NavState.flow` is
`campaign`) rather than a step of the panel's, because it is a conversation
where the panel's other screens each answer one tap.

The queue is `notification`'s (F-035-d/e), the pace is `messenger`'s ceiling
(F-313-a/c, ADR-0066) and the door is F-313-d. What is decided here is the
order of the screens, the segments a chat can offer, and the channel.

| rule | why |
|---|---|
| The row is drawn where `NOTIFICATION_API_BASE_URL` is set, and `canWrite` is asked by the flow itself, on the screen that offers the write | the panel's row already cost a verdict; a second one to decide whether to draw a row inside it would ask the door twice for one menu. Who may *start* a broadcast is still never the bot's rule |
| A reseller the door will not let write gets the **list of what it has sent**, not the segments | `tenant/rules.md`: a suspended reseller reads what it did and starts nothing new. Segments it may not use are a refusal wearing a button. An unreachable door is read the same way |
| The segments are a **closed list of compositions** of `notification`'s audience filter — all customers, active only, joined in the last 30 days | that filter is `strict` and the fan-out reads exactly its keys (F-035-d), so a chat may compose it and never extend it. A new key lands in that schema and the fan-out first, and on a button afterwards |
| The button carries the segment's **key**; the flow resolves the filter | a payload is input, and an audience that arrived as input is an audience a caller can write — the same reason a customer is opened by re-listing rather than from the button's id |
| The count is `notification`'s (`POST audience/count`) and the screen calls it *about* | it is counted now and the send starts later: whoever signs up in between is counted by the send and not by the count. That difference is `notification/contract.reseller.md`'s, stated on screen rather than hidden |
| An empty segment ends there, on the segments screen | writing a message for nobody is work the flow can spare |
| The channel is **this bot's messenger** (`telegram_bot` / `bale_bot`), from an exhaustive record over the platforms | the reseller is writing inside its Telegram bot, so the broadcast is the Telegram one. SMS and email are the panel's to offer, and a delivery-line question a chat has already answered by existing is a screen for nothing |
| Free text on the *write your message* screen is the message; anywhere else in the flow it answers a screen that asked nothing | the same rule the customer list applies to its search box |
| The typed message becomes a **draft row in `notification`** immediately, and this flow keeps only its id | ADR-0010: a commitment is a row in the domain that owns it the moment it becomes one. A chat abandoned on the confirmation leaves a draft the reseller can find again, never lost work or a half-sent broadcast |
| Nothing about the text is judged here — length, the channel's availability, whether this reseller may draft at all | all of it is already a rule on the other side, and a second copy in the bot is what ADR-0009 forecloses. A refusal renders as `notification`'s own sentence, `raw` |
| The confirming tap must name the campaign the state does (`csend:<id>`), and `cstat:` / `camp:` are separate prefixes | sending to every customer is the irreversible tap and must not share a payload with looking at one. A stale confirmation from an earlier draft **shows** that campaign instead of starting it |
| *Watching it go* is the refresh button, re-reading the campaign each time | a chat has no other way to watch anything, and the counts are `notification`'s alone |

Editing a draft, the per-language texts and stopping a send have no screen
here, because F-313-d has no route for them — stopping stays the platform
owner's (F-018-x).

## Not here

Creating a user and renewing one (the other half of F-311) wait on
`entitlement`, as F-311-d does. F-312 (sub-resellers) and F-1531 (the business
summary) read the same verdict this file's menu row turns on.
