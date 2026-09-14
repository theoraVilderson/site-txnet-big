---
id: panel-web
layer: interface
status: active
version: 18
updated: 2026-09-14
---

# Contract — panel-web: payments to confirm (F-093-n)

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
6. **Flagged is visible.** A payment billing flagged after a day of retries
   (F-092-y) carries a "needs a person" badge beside "verifying". Colours are
   theme tokens, never gold.

## Proof

`payments/manual/manual-payments.test.ts` — the outcome union against the
service source, `validateConfirm`'s limits, `canConfirmByHand` for every
outcome, the menu entry's permission, every key in `en` and `fa`.
