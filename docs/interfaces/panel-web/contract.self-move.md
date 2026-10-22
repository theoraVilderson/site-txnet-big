---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-22
---

# Contract — panel-web: «تغییر سرور», a user moves their own config (F-410-d)

The user's side of network's self-move (F-410-b/c; server rules: network
[contract.config-move.md](../../domains/network/contract.config-move.md)
"Self-move"). A §10 split of [contract.my-services.md](contract.my-services.md),
beside [contract.own-freeze.md](contract.own-freeze.md). The reseller's switch
and wait are F-410-f; the bot's button F-410-e.

Pieces: `services/_components/ConfigMove.tsx` (the button on each config under
"manage", in `GrantConfigs.tsx`, and its dialog), `services/_hooks/useMoveTargets.ts`,
`services/_lib/config-move.ts` (`moveOfferOf`, `targetOptions`, `moveWaitOf`),
and `billingApi.configMoveTargets` / `moveConfig` (`lib/billing/config-moves.ts`)
over `GET /api/billing/traffic/configs/:id/move-targets` and `POST …/move`.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | **The targets are read once per list**, through its first config (`useMoveTargets`), and again whenever the list's config ids change; an answer read for another list is not used | the targets and the wait are the Grant's, so one read covers every row; a move changes the ids, which is how the wait after it appears |
| 2 | **What a config offers is `moveOfferOf`**: nothing when switched off, with no server to go to (a `mirror` Grant, a Grant of no group) or when the read failed; the button off with "again from …" inside the wait; else the button | billing's answer, never re-derived; a button that can only be refused is not drawn |
| 3 | **A server is its region** (`targetOptions`), numbered in billing's order when two share one; never a name or address | billing answers nothing else of a panel (F-410-b), and two identical words are no choice |
| 4 | **Asked in a dialog** (kit `Dialog` and `RadioCards`, C-13) that says the link changes and the wait after a change; Cancel sends nothing | a move retires the old link: the user's app must take the new one |
| 5 | **Nothing is patched from the answer**: a move closes the dialog, toasts the region and re-reads the list; the new config's lines and QR arrive on `network.grant.linksCaptured`, which `useGrantConfigs` already re-reads on (C-14) | the new row has no lines until network-service captures them; nothing polls |
| 6 | **A refusal stays in the dialog**: `move_cooldown` as "again from …" (`facts.nextAtMs` → `moveWaitOf`), anything else as billing's sentence with its ref; the list is not re-read | refused whole, nothing moved; the sentence is billing's |

## Proof

`services/config-move.test.tsx`: `moveOfferOf` over off, no targets, the wait
and open; `targetOptions` numbering; `moveWaitOf`; no button with nowhere to
go; the wait drawn with the button off; pick, confirm, move and re-read; a
`move_cooldown` refusal named in the dialog with no re-read.
