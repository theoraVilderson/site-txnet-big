---
id: panel-web
layer: interface
status: active
version: 16
updated: 2026-09-12
---

# Contract — panel-web: the top-up page (F-093-e)

A topic file of [contract.md](contract.md) (§10). `/financial/deposit`:
`financial/deposit/page.tsx` around `_components/DepositView.tsx`, which holds
`AmountInput`, `CouponInput`, `GatewaySelector`, `WalletPreview` and
`PaymentSummary`. It is the panel half of
[billing/contract.deposit.md](../../domains/billing/contract.deposit.md) —
`GET /deposit/gateways`, `POST /deposit/quote`, `POST /deposit/start`. The
callback and the pages a bank returns to are F-092-j's and F-093-f's.

## The one rule everything here follows

**Every figure on this page is one `billing` answered for the inputs currently
on screen.** The page's own state is only what the user chose: a gateway, an
amount, and a list of codes. The bill — discount, fee, the gateway-minimum
adjustment, what is payable, what will be credited, what the bank will charge
in its own currency — is `POST /deposit/quote`'s answer, rendered field by
field.

That is F-0612 as a screen. Legacy computed the same bill twice: `Deposit.tsx`
held `feeAmount`, `taxAmount`, `calculatedBasePayable`, `adjustmentGap` and a
projected balance as component state and recomputed them in the render, beside
a server doing the same arithmetic. The two drifted, which is why the quote
route returns the whole breakdown instead of the pieces of one.

`deposit.test.ts` is that rule as a test.

## Rules

1. **A quote belongs to the inputs it was asked for.** The moment the amount,
   the gateway or the codes change, the previous breakdown is dropped —
   `useDepositQuote` keys the read to the exact body it will send and answers
   `null` for anything else. Keeping the old numbers warm under new inputs is
   the same disagreement with a delay on it.
2. **Quotes are debounced (500ms), because a quote is a call to a bank.** At an
   automatic-fee gateway it asks the provider for a fee, and the route allows
   60 per 900s per user. One per keystroke spends a user's budget and then
   shows them a 429.
3. **Paying sends the quote's body, never its numbers.** `start` re-prices from
   the same inputs with the same code, so a client cannot pay a figure it was
   shown before the rate moved. The button is disabled unless a quote for the
   current inputs is on screen.
4. **A rejected coupon is part of a successful answer.** The quote comes back
   without that code, carrying a sentence `billing` already translated
   ([contract.errors.md](contract.errors.md)), and the code **stays in the list,
   marked** — dropping it silently is how a code the user believes is applied
   disappears between renders. There is no validate-one-code call: adding a code
   changes the inputs, and the next quote is the verdict. Legacy checked each
   code against its own endpoint, cached the answer, and re-checked the list on
   every amount change — three copies of what a coupon was worth.
5. **The only refusal this page owns is "that code is already in the list".**
   Every other verdict — the range, the gateway, the limiter, a hold that can
   no longer be taken — arrives translated and is shown as it came. A 409 on
   `start` wrote nothing, so the next quote simply comes back without the code.
6. **The wallet card shows two figures and never their sum.** The balance
   `billing` last answered, and the quote's `credited` beside it. Legacy printed
   `balance + charge` as "your balance after topping up"; that is client
   arithmetic on money with a soft label, and
   [contract.shell.md](contract.shell.md) rule 1 is the correction. `credited`
   already carries the adjustment gap, so the two figures say everything the
   projection did and neither is a guess.
7. **The gateway's range is the configuration.** `minAmount` / `maxAmount` from
   the gateway list are the amount box's bounds, its slider's ends and the
   source of its presets (`_lib/deposit-amount.ts`). Legacy kept six rial
   figures and a two-million ceiling in `_util/constants.ts` — one tenant's
   pricing decision compiled into the app, wrong for every other tenant.
   **Still open:** a tenant cannot yet name its *own* preset ladder; deriving
   one from the range it already publishes is what this row does instead of
   inventing a route.
8. **The amount box works in integer cents and speaks ASCII.** A slider that
   emits a float is how `0.1 + 0.2` reaches a payment route as
   `0.30000000000000004`; Persian digits typed into the box are converted at
   the boundary, because the route's own regex takes ASCII only and a `fa` user
   would otherwise get an unexplained 400.
9. **Every gateway in the picker is usable.** The route leaves out anything with
   no driver, no verified config or no merchant id in the vault, so there is no
   disabled state and no "why can't I pick this". Legacy intersected a
   hard-coded `GATEWAYS` array with the server's list, so a gateway the tenant
   had just added appeared nowhere until the app was rebuilt.
10. **The free path ends here, not on F-093-f's pages.** A fully discounted
    top-up is credited inside `start`'s own transaction and mints nothing, so
    there is no gateway to be sent to and nowhere to come back from. The page
    shows what `start` answered — `credited` and the new `balance`, both
    billing's — and tells the top bar to re-read.
11. **One summary component, two placements.** Sticky beside the form from `md`
    up, a fixed footer below it, with the lines behind a disclosure. Legacy had
    the same component twice with different props, and passed `isLoading` to
    one of them — so the footer and the card could show different figures.
12. **No animation library on this page.** Nothing here needs an exit, an `auto`
    height or an imperative gesture, which are the three things
    [contract.shell.md](contract.shell.md) rule 6 says earn framer-motion. The
    amount box is controlled and re-renders the whole form per keystroke, which
    is exactly the cost that rule was measured on.
13. **A verifying payment warns; it never blocks (F-093-m, ADR-0044 decision 7 —
    the user's choice, 2026-09-14).** `useVerifyingGuard` reads the caller's
    `pending` attempts (`VERIFYING_QUERY`) when the page opens and shows
    `VerifyingBanner` (the money is safe, where to watch it) for one with
    `verifying`. Pay goes through `guard`, which **re-reads** at that moment: none
    verifying pays at once; one verifying opens `VerifyingConfirm` — "don't pay"
    is the prominent, focused answer, "pay anyway" always pays. A check that
    fails pays: a courtesy must not become a gate. Proof:
    `deposit/verifying-guard.test.ts`.

## What this page does not do

No tax row: tax is already inside the figures `priceAtGateway` answers, and a
row this app computed would be one more number nothing vouches for. No display
currency: amounts are base currency until F-025, and `charge` is shown as the
gateway's own figure beside the payable rather than converted here. No live
staleness on the rate — that ladder is F-0607-a's.

## Proof

`financial/deposit/deposit.test.ts` — the quote hook (nothing is derived, a
changed input drops the old bill at once, one call per burst, a slow answer to
abandoned inputs never lands, a rejected code is not a failure) and the amount
helpers (cents in and out, minor units split on the digits, presets from the
gateway's range).
