---
id: bot-app
layer: interface
status: active
version: 13
updated: 2026-10-03
---

# Contract — bot-app: the lucky wheel (F-707-h)

A topic file of [contract.md](contract.md). `flows/wheel.flow.ts`, the
`🎡 Lucky wheel` row on the member menu (`ACTIONS.wheel`), and two calls in
`billing-api/billing-api.client.ts` — the panel's own `GET /api/billing/wheel`
and `POST /api/billing/wheel/spin`, through the gate (ADR-0009). The rules
they serve are engagement's ([contract.md](../../domains/engagement/contract.md)
"The spin", ADR-0111 point 4).

## Rules

1. **The bot decides nothing.** Eligibility, limits, odds and the pick are
   billing's. The device a spin names is this chat: the gate writes
   `X-Chat-Platform` / `X-Chat-User-Id` from the chat's session, so the chat's
   accounts count toward D-11's five, as the panel's browser does.
2. **The row is behind billing's reachability** — shown exactly when the
   top-up row is (`BillingApiClient.isConfigured`). Whether a wheel runs today
   is billing's answer, told as `wheel.none`.
3. **The screen is the odds and a status.** Each slot as `label — percent%`
   (the label is the tenant's data, shown raw); then either the spins left and
   a Spin button, or `cannotSpin` with the reason's sentence and no button.
4. **One screen, one key.** The screen's state holds a `requestId`. A lost
   answer (no `error.reason`) or `spin_in_progress` keeps it and offers Spin
   again, so the retry is the same spin; any other answer ends the
   conversation. A Spin whose state expired opens a fresh screen, never a spin.
5. **The prize is told in the chat**, by kind; a coupon with its code. A
   recorded refusal (`200`) and an unrecorded one (`4xx`) are both told by
   the reason's own sentence (`wheel.refusals.*`, the same set as the panel's);
   an unknown reason falls back to billing's translated `msg`.

## Proof

`flows/wheel.flow.spec.ts` — the screen's odds, status and key; no button when
refused; `no_wheel`; the spin with the screen's key; a coupon's code; a
refusal and an empty slot; the key kept after a lost answer.
`locale/bot-copy.spec.ts` holds the new keys in `en`, `fa` and the fallbacks.
