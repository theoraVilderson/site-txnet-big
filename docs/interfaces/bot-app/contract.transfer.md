---
id: bot-app
layer: interface
status: active
version: 16
updated: 2026-10-15
---

# Contract — bot-app: a manual transfer in the chat (F-805-b)

A topic file of [contract.md](contract.md). A card-to-card or wallet top-up
paid from the chat, and its receipt judged from the chat:
`flows/transfer-pay.flow.ts` (the payer), `flows/transfer-review.flow.ts` (the
reviewer), `flows/transfer.views.ts` (their screens) and the `🧾 Receipts to
review` row of `conversation/chat-menu.ts`. Both reach billing's own routes
through the gate (`BILLING_API_BASE_URL`, chat access token as Bearer) — the
deposit routes the pay page uses and the manual-payments queue the panel uses
— so a transfer started in the chat is the one the panel shows, and a receipt
confirmed in the chat is confirmed once (ADR-0009). The rules are billing's
([contract.manual-transfer.md](../../domains/billing/contract.manual-transfer.md)).
Decided by the user 2026-10-15: a notice and a menu row, the payer's own
reference, a reject that asks once more.

## Rules

1. **The bot decides nothing.** Whether a field is right, a reference new, a
   payment still open, who may judge it and what an act does are billing's. A
   refusal is told by its `error.reason` in the bot's own sentence
   (`transfer.refused.*`, `transfer.review.*`), else billing's translated `msg`.
   Every figure is billing's string; a minor-unit amount is shown with its
   point moved as text (`minorAsDecimal`), never computed.
2. **The pay screen.** `start` on a manual gateway answers `transfer`
   (F-803-d); `TopUpFlow` hands it to `TransferPayFlow.show`: the exact amount,
   every public destination field by its label — but `bankId`, the panel's to
   draw — the minutes left in the window, and the first proof to send. Its
   `📎 Send the receipt` button (`mtp:<paymentId>`) re-reads
   `GET …/deposit/:paymentId/transfer` from any state: closed → `transfer.closed`,
   proof already sent → `transfer.alreadySent`, else the pay screen again — so
   a payer back after the conversation expired (30 min, `BOT_NAV_TTL_SEC`), or
   after a reviewer sent the receipt back, starts from billing's answer.
3. **The proof, one field at a time**, in the seller's `requiredProof` order
   (nav state `transfer` / `transfer.proof`: the payment, the fields left, the
   typed answers — ADR-0010). `receiptImage` is a photo or an image document,
   fetched from the platform (`ChatFiles`, ≤20 MB) and uploaded to
   `POST …/proof/upload` **the moment it arrives** — only its key is kept.
   `paidAt` is a button (now, 10, 30, 60 minutes ago) spelled into an instant;
   every other field is typed text handed over untouched. No proof asked: one
   `✅ I have paid` button sends `{}`.
4. **One submit.** After the last field, `POST …/proof` with every answer by
   its field id. A field billing refuses (`error.facts`, or `receipt_missing`)
   is asked again alone, the other answers kept; any other refusal ends the
   conversation in its sentence (`duplicate_ref` points back to the button).
5. **The reviewer's row** shows only to a token carrying
   `payment.confirm_manual` (`*` included, `tokenHolds`) where billing is
   reachable — read off the token like the restriction (ADR-0133), never a
   boundary: billing refuses every tap without it.
6. **The list** is `GET /api/billing/payments/manual` narrowed to transfers
   whose payer sent a proof, oldest first, at most 10, each `amount ·
   destination label`. **One receipt** is read from the same list (there is no
   single-payment route); its picture comes from
   `GET …/payments/manual/:id/receipt` and is sent **before** the screen
   (`FlowResult.picture`), whose buttons judge it. Never the signed
   `receiptUrl`: it is a path on the gateway owner's panel Host. No picture →
   the screen says it is on the panel's manual payments page.
7. **Three acts, buttons that name the payment** (`mtr:<act>:<id>`, ≤64 bytes,
   no state): `c` confirm — one tap, no reference typed, billing records the
   payer's own; `r` send the proof back, only while `canReturn`; `x` asks
   "reject for good?" and changes nothing, `y` rejects. Each sends a fixed
   reason in the reviewer's language (`transfer.review.reason*`) and answers
   the outcome's sentence with `🧾 All receipts` (`mtr:l`). A payment no longer
   in the queue, or `not_open`, is `transfer.review.gone`.
8. **The notice.** A proof tells each person of the gateway's owner who holds
   `payment.confirm_manual` (billing, outbox `transfer_proof_sent`), inbox and
   bot, class `important`; the bot message carries `🧾 Review the receipt`
   (`transferReviewCallback`, shared-core: `mtr:o:<paymentId>`; `mtr:l` when
   the notices were combined), which this unit routes from any state.

## Not here

The payer is told of a confirmed transfer by the ordinary payer notice
(`paymentCredited`, quoting their reference, else the payment's id). A receipt
sent back or a payment rejected is not yet told in the chat — the pay page
hears it over the socket; the payer's button shows where it stands. Bank names
and the drawn card are the panel's (F-803-i).
