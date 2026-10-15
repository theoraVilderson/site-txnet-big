---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-15
---

# Contract — panel-web: freezing one's own service on My services (F-0401-e)

The user's side of billing's self-freeze (F-0401-c; server rules: billing
[contract.gift.md](../../domains/billing/contract.gift.md) "Freezing one's own
service", entitlement [contract.admin.md](../../domains/entitlement/contract.admin.md)
"A freeze has a mode"). A §10 split of [contract.my-services.md](contract.my-services.md),
which was at its ceiling. The admin's side is [contract.reseller-users.md](contract.reseller-users.md) rules 38–40.

Pieces: `services/_components/OwnFreeze.tsx` (`FrozenNote` on the card,
`FreezeOwn` under "manage"), `services/_lib/own-freeze.ts` (`ownFreezeOf`,
`freezeLimitOf`, `dailyLimitOf`), `services/_hooks/useDailyLimit.ts` (shared
with the link reset), `readFreezeChanged` in `services/_lib/my-services.ts`,
and `billingApi.freezeOwnGrant` / `unfreezeOwnGrant` over
`POST /api/billing/gift/grants/:id/freeze` / `…/unfreeze`.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | **What a card offers is `ownFreezeOf`**: on a frozen row, an unfreeze where billing's `userMayUnfreeze` is true, else "frozen by support" with no button; on a live (`active`) **metered** row, a freeze. A prepaid package, and a row its quota stopped (`suspended` but not `frozen`), offer nothing | who may lift it is billing's answer, never re-derived from `freezeMode` — a soft freeze waiting for a panel is support's too; a prepaid package frozen by its user would buy free days |
| 2 | **A frozen row says who froze it** on the card, above the configs (`FrozenNote`): "you froze it" (`self`), "support froze it, you may unfreeze it" (`soft`), "frozen by support, only support lifts it" (`hard`, or `userMayUnfreeze` false), and the end of a timed freeze | a service that stopped working names why where the user looks first |
| 3 | **The freeze is under "manage"** (`FreezeOwn`), the unfreeze on the card | a freeze switches every config off — like the link reset, it can break a working setup, so it is never above one (contract.my-services.md) |
| 4 | **Both ask first**, through the kit's `useConfirm` (C-13); a declined question sends nothing | a freeze stops every device the user has on it |
| 5 | **Nothing is patched from the answer.** The button stays busy until the row it was pressed on has moved; the page re-reads on `entitlement.grant.freeze_changed` for a row it shows (`readFreezeChanged`, C-14), and on a reconnect as for any push | billing writes the event in the act's transaction (realtime `contract.live-events.md`); status, mode and who may lift it are the list's to say |
| 6 | **The daily cap is named** (`self_freeze_limit`, 429, `facts {limit, nextAtMs}` → `freezeLimitOf`): how many in 24 hours and when the next is allowed; the button is off until then and comes back by itself (`useDailyLimit`) | the same shape as the link reset's cap (F-114-e-d); billing still decides |
| 7 | **Any other refusal is billing's sentence** with its ref — `self_freeze_off` names the reseller's off switch ("not available in this store"), `freeze_not_users` support's freeze | the sentence is billing's (`OWN_FREEZE_REFUSAL`), so the panel never words a rule it does not hold |

## Proof

`services/own-freeze.test.tsx`: `ownFreezeOf` over metered, prepaid,
quota-stopped and the three modes (a soft freeze answered `userMayUnfreeze:
false` is support's); `freezeLimitOf`; a hard freeze named with no button; an
unfreeze declined then confirmed; a freeze from manage after the question; the
daily cap named with the button off; `self_freeze_off` in billing's sentence;
`readFreezeChanged`.

## Not covered

How long a freeze lasted, and whether its clock stopped, are not shown — the
list answers neither. The bot's own freeze is F-0401-g. A freeze for a payment
dispute (`payment_dispute`, CB-1-f) is named as support's until
[contract.disputes.md](contract.disputes.md) U4 is built.
