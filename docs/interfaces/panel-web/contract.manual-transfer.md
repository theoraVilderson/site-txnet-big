---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-06
---

# Contract — panel-web: paying by card-to-card or to a wallet, and setting them up (F-803…F-807)

The pages a user pays a manual transfer on, and the admin pages a seller sets
cards and wallets up on. Decided by the user on 2026-10-06 (D-60); written
before any of it is built — each rule names its backlog row. Routes, fields and
the matching rule are
[billing/contract.manual-transfer.md](../../domains/billing/contract.manual-transfer.md);
this file never redefines one. Every motion follows contract.ux.md M1–M4:
tokens from `src/lib/motion.ts`, and under `reduced` only opacity ≤ 120 ms — no
tilt, flip, count-up, stagger or confetti. Gold is never on a button or control.

## Principles (every row)

1. **A renderer per kind.** `_components/transfer/kinds/<kind>.tsx` exports
   `{Destination, ProofField, AdminFields}`; the registry
   `transfer-kinds.ts` maps a `kind` to it. A new billing kind is one new file
   here and one map line; an unknown kind falls back to a plain list of the
   destination's public fields, so a page never breaks on a new kind.
2. **The exact amount is the one thing the user must not get wrong.** It is the
   largest figure on the page, copied in one tap, and its unique digits
   (F-804, **later**) are drawn apart with a one-line reason ("these digits
   identify your payment"); until then the pill is not drawn.
3. **Live, never polled** (C-14). The pay page re-reads `GET …/transfer` on
   `billing.payment.confirmed` / `reversed` / `transfer_seen` for its
   `paymentId` (`useLiveReread`) and on tab visible. The countdown is a clock.
   `transfer_seen` and every "automatic" text below are **later** (F-803-f,
   deferred by the user 2026-10-06): the renderer keeps their slot, today
   nothing sends them and only the manual texts show.
4. **Every string is a locale key** (C-06), Persian and English; numbers in the
   user's locale digits, but a card number, address and tx hash are always
   Latin digits and `dir="ltr"`, so copy and paste match the bank's form.

## The pay page `/payment/transfer/[paymentId]` (F-803-i, F-803-j)

One page for every kind; the kind supplies the middle.

| part | behaviour |
|---|---|
| Stepper | `send` → `proof` → `checking` → `credited`; the active step's dot fills and a progress line grows between steps (`layout`); a step done draws a check (path length 0→1, `base`) |
| Countdown | a ring around the remaining minutes of `windowEndsAt`, green until 5 min, then the `warning` tone; at 0 the page swaps to "time is up — paid already? send the proof" while the grace lasts |
| Amount | `AnimatedNumber` once on enter; the unique digits in a tinted pill; copy button morphs copy → check for 1.2 s with a light haptic (`navigator.vibrate(10)` where it exists) |
| Proof | only the fields in `requiredProof`, from the kind's `ProofField`; `receiptImage` is a drop zone with paste-from-clipboard, a preview that scales in, and an upload progress bar; submit stays disabled until every field validates |
| Checking | a soft pulsing halo on the step; text by `confirmationMode`: automatic "we are watching the network", manual "a person confirms this, usually within <n> minutes" (the gateway's figure) |
| Credited | the ring fills to a full circle, the check draws, the wallet balance counts up, a short confetti burst (`full` only); buttons back to the wallet and to the shop |
| Review / rejected | the `reviewReason` as one sentence and what to do; `resubmit` reopens the proof form |

### Card-to-card (F-803-i)

A bank card drawn in CSS at 85.6 : 54 — the bank's colour pair as a gradient
from `iran-banks` (unknown: the brand's green), the bank's logo, a chip, the
number in 4-4-4-4 groups. Pointer or gyroscope tilts it up to 8° with a moving
light sheen (`full` only); tapping it flips it to the back with the holder's
name and the sheba, each copyable. Below it: copy-number as the primary button,
the holder name repeated in plain text ("check the name your bank shows matches
this"), and the exact amount in rials with its toman in words.

### Wallet (F-803-j)

A QR of the address (`qrcode.react`) in a rounded frame with the asset's icon
at its centre; the address in segments with the first and last six characters
emphasised ("compare these with your wallet"), copy as the primary button. A
network chip in the `warning` tone with "send only on <network>" — the
seller's own text, shown verbatim. A memo, when set, is a second copy row with
a red "required" mark. Amount in the asset with its decimals and copy. The tx
hash field checks length/charset per known network and pastes in one tap. In
automatic mode (**later**, F-803-f), after the watcher first sees the transfer, a confirmations bar
fills `n / required` live from `transfer_seen`.

## The deposit picker (F-803-h)

Gateways arrive grouped: automatic first, then manual, each group headed. The
first automatic one is selected; if there is none, the first manual one. A
manual gateway's tile shows its kind's icon and a `info` badge "confirmed by a
person" or a `success` badge "confirmed automatically". Start on a manual
gateway navigates to the pay page instead of a redirect; the existing
pay-once guard (`useStartOnce`) applies unchanged.

## Admin: `/gateways` (F-803-g) and the queue (F-803-k)

- `/gateways` gains two sections, **automatic** and **manual**, the second a
  list of the tenant's manual gateways by kind. The wizard's first step picks
  a kind from the registry (cards with an icon and one sentence each).
- The destination editor previews live: typing a card number fills the drawn
  card as you type, the bank resolves from the first six digits with a fade,
  a Luhn failure shakes the field once (`full`) and says why. A wallet address
  renders its QR beside the form. Reordering is drag with a handle; `weight`
  and `dailyCapMinor` sit under "advanced".
- `confirmationMode`: a segmented control drawn only when the kind or network
  has a watcher — so not before F-803-f; until then every manual gateway is
  `manual` and the control is absent. `requiredProof`: checkboxes from
  the kind, at least one.
- The manual-payments screen (F-093-n) shows a transfer row's destination
  label, expected vs. claimed amount, the proof fields, the receipt in a
  lightbox (pinch/scroll zoom), a tx hash linked to the network's explorer
  when known, and the `reviewReason` badge. Confirm and reject are the existing
  forms, reject gaining "let them send it again".
