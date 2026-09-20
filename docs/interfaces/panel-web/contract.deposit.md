---
id: panel-web
layer: interface
status: active
version: 17
updated: 2026-09-20
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
   `start` wrote nothing, and it is the one refusal that also **re-prices the
   page** (F-093-s): the same inputs are asked again on the spot, so the code
   comes back in `rejected` and the bill without it. Until that happened the
   payer read a discount they could not have and a payable nobody would charge,
   and pressing Pay again repeated the same 409. No other status re-quotes —
   the range, the gateway and the limiter all answer the same bill back, and
   the quote route has a budget of its own (60 per 900s) to spend.
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
   Either bound may be `null` (no limit): the box checks only the side that is
   set, the slider needs both, and with no maximum the ladder is `STEPS` alone.
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
14. **An in-chat gateway pays in the messenger's sheet, then waits on the row
    (F-104-o, D-32).** The page never decides who sees one: `billing` lists it
    only for a Mini App session of that messenger (F-104-q,
    `domains/billing/contract.webhook.md` "Settling in the chat"), so a browser
    never has it to pick. `start` answers `invoiceLink`; `openMiniAppInvoice`
    ([contract.mini-app.md](contract.mini-app.md)) opens it. `paid` or
    `pending` renders F-093-l's `PaymentPendingView` for that payment id — the
    sheet's word is not a credit, the bot's relay is — and it turns into the
    success card when the row does. `cancelled` returns to the form silently;
    `failed` and `unavailable` (no SDK, no method) are a sentence of this
    page's own. The unpaid row is billing's to expire.

15. **One press of Pay starts one payment (F-093-r).** The click claims the
    start synchronously — `useStartOnce`, a ref — and the button is disabled
    from that moment, not from when `start` goes out. Rule 13's guard awaits a
    network read first, and a `useState` set after it is set one read too late:
    both clicks of a double click found the old `false` and sent their own
    `start`, which is two payment rows and two sets of coupon holds, the second
    usually a 409 on a one-use code. The claim is released on every path back
    to the form — a dismissed warning, a refusal, a sheet closed unpaid — and
    never on the trip to the gateway, where the page is leaving anyway.

16. **A refusal of `start` belongs to the inputs it was refused for (F-093-t),
    and never speaks over the bill's own verdict.** The sentence is held with
    the key of the gateway, amount and codes it answered, so changing any of
    them drops it in that render — rule 1 for the other half of the page. It
    was plain state cleared only inside `pay()` and `reset()`, so one bank's
    503 stayed over the next bank's bill; and it was shown *instead of*
    `quote.error`, so while it was up a new refusal of the quote itself — the
    range, the gateway, the limiter — had nowhere to go. The quote's error is
    the current answer about the bill on screen and wins; a start refusal shows
    while the inputs it belongs to are unchanged. Proof:
    `deposit/start-error-clears.test.tsx`.

## What this page does not do

No tax row: tax is already inside the figures `priceAtGateway` answers, and a
row this app computed would be one more number nothing vouches for. No display
currency: amounts are base currency until F-025, and `charge` is shown as the
gateway's own figure beside the payable rather than converted here. No live
staleness on the rate — that ladder is F-0607-a's.

## Proof

`financial/deposit/pay-once.test.tsx` — two clicks inside the verifying check
send one `start`, the button goes dead on the click, a dismissed warning gives
it back, and "pay anyway" still pays once.

`financial/deposit/requote-on-refusal.test.tsx` — a 409 on `start` asks the
same body again and the discount line goes, with the code still listed and
marked; a 400 spends no quote.

`financial/deposit/start-error-clears.test.tsx` — a start refusal clears when
the gateway, the amount or a code changes, survives a render that changed
nothing, and does not hide the quote's own refusal.

`financial/deposit/deposit.test.ts` — the quote hook (nothing is derived, a
changed input drops the old bill at once, one call per burst, a slow answer to
abandoned inputs never lands, a rejected code is not a failure) and the amount
helpers (cents in and out, minor units split on the digits, presets from the
gateway's range).
