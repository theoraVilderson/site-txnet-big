---
id: panel-web
layer: interface
status: active
version: 18
updated: 2026-09-14
---

# Contract — panel-web: payments to confirm (F-093-n, F-093-o)

A topic file of [contract.md](contract.md) (§10). One page, `/payments/manual`
(`PANEL_MANUAL_PAYMENTS`), under `(panel)/payments/manual/`: `page.tsx` is a
server shell, `_components/ManualPaymentsView.tsx` the screen, and
`_lib/manual-confirm.ts` its rules. It is the panel end of billing's manual
confirmation — the routes, the scope and the credit are
[billing/contract.verify.md](../../domains/billing/contract.verify.md)'s
(F-092-z, ADR-0044 decision 6). It replaces legacy's off-the-books manual
top-up.

## Rules

1. **The permission hides it; billing scopes it.** The menu entry (`financial`
   group) `requires: ["payment.confirm_manual"]`. What is listed — the platform
   owner every tenant's payments, a tenant its own users' on its own gateway
   configs — is billing's answer, never a filter here.
2. **Inquire, then confirm.** Every payment offers "ask the gateway" first
   (`billingApi.manualInquire`). The hand-confirm form appears only after that
   answered `unsettled` on this screen (`canConfirmByHand`). Billing asks once
   more itself before crediting, so a payment settled in between is the
   gateway's, not the person's.
3. **The form asks for exactly what billing keeps**: the gateway's reference
   (1–64) and a reason (5–500), both trimmed — `validateConfirm` mirrors
   `manual-confirm.schema.ts`. There is no amount field: billing credits the
   row's own `amountCredited`.
4. **One sentence per outcome, checked against billing.** `OUTCOME_KEYS` is a
   `Record` over `ManualOutcome`, and the test reads that union from
   `manual-confirm.service.ts`; the service spells it out as literals so it
   can be read.
5. **Nothing is patched from an answer.** A settled answer re-reads the list;
   its sentence moves to a page-level notice, because its row leaves the list.
   An `unsettled` answer keeps the row and opens the way to the form.
6. **Every open payment, badged** (F-093-o, ADR-0046 decision 7). Billing lists
   every `pending` or `expired` payment of the lookback; `stateBadges` names
   each: `waiting` (pending, not verifying — likely still at the bank),
   `verifying`, `expired`, and the two that ask for a person as alerts —
   `flagged` (a day, or half a gateway's window) and `noAuthority`. Colours are
   theme tokens, never gold.
7. **A lost authority is typed in, then asked about.** Only a payment with no
   authority offers "enter authority" (`canAttachAuthority`); the form takes
   the gateway's authority (1–64, trimmed — `validateAuthority` mirrors
   `manualAuthoritySchema`) and `billingApi.manualAttachAuthority` answers the
   gateway's word, handled like an inquire.
8. **The payer's pending page** (`pendingStateOf`) keeps waiting on an
   `expired` payment — billing still asks the gateway for a week — and says
   "reversed, the bank is returning it" for `failed` / `failureCode: reversed`.
9. **Reject by hand, after asking** (F-093-p → F-092-ak). "Reject by hand"
   appears on the same condition as "confirm by hand" (`canRejectByHand`:
   the last answer here was `unsettled`). Its form takes only a reason (5–500,
   trimmed — `validateReject` mirrors `manualRejectSchema`) and warns that a
   rejected payment the bank did charge is not reopened automatically. Billing
   answers `rejected_manually`, or `still_in_bank` for a payer still at the
   bank, or the gateway's own word; each has its sentence, and all reload the
   list like any settled answer. Error-toned theme tokens, never gold.

## Proof

`payments/manual/manual-payments.test.ts` — the outcome union against the
service source, `validateConfirm`'s limits, `canConfirmByHand` for every
outcome, `stateBadges` per state, `canAttachAuthority` and
`validateAuthority`, `canRejectByHand` for every outcome and `validateReject`'s
limits, the menu entry's permission, every key in `en` and `fa`.
`payment/_lib/pending-payment.test.ts` — expired waits, reversed reads so.
