---
id: panel-web
layer: interface
status: active
version: 17
updated: 2026-09-12
---

# Contract — panel-web: where a bank returns a payer (F-093-f)

A topic file of [contract.md](contract.md) (§10). Two pages,
`/payment/success` and `/payment/failed`, under
`(panel)/payment/`: `success/page.tsx` and `failed/page.tsx` read the query
string, `_lib/payment-result.ts` turns it into what is shown, and
`_components/` holds the card both share. They are the far end of
[billing/contract.deposit.md](../../domains/billing/contract.deposit.md)'s
callback — the top-up page that *starts* the trip is
[contract.deposit.md](contract.deposit.md).

## The one rule everything here follows

**These pages report an outcome that is already final. They settle nothing,
call nothing, and retry nothing.** By the time the browser arrives, the
callback has verified with the gateway outside every transaction, flipped the
payment under a status guard, credited the wallet and written the event
(ADR-0028). What reaches this app is a redirect carrying one signed token
(`?t=`, rule 10), and the whole of both pages is how that is read.

That is why neither page has a client data path, a loading state or an effect.

## Rules

1. **The two paths are `billing`'s, not this app's.** `deposit-callback.
   controller.ts` writes `/payment/success` and `/payment/failed` out as
   literals, so renaming a route here would strand a payer on a 404 at the end
   of a real payment. `PAYMENT_SUCCESS` / `PAYMENT_FAILED` in `lib/routes.ts`
   are those two paths, and `payment-result.test.ts` reads the controller's own
   `RESULT_PATH` to keep them equal.
2. **A missing reference is not a failure.** `?ref=` is the bank's receipt
   number, not the verdict: the callback omits it for a row settled before the
   column existed, or by an admin who had none. Legacy branched its entire
   success page on `ref` and told a paid user their payment had failed.
3. **`?already=1` says it, and does not celebrate twice.** A reload, a retried
   webhook or a redirect that lost a race lands here with the flag, and the
   page says the wallet was credited once and will not be credited again.
   Nothing about the money differs; what differs is what the user is told.
4. **Nothing unrecognised is printed.** An `?error=` that is not one of the
   five codes gets the general sentence and is *not* echoed; a `?ref=` outside
   the alphabet a reference uses is dropped. Legacy printed the raw query
   string as `Error Code: …` — a stranger's text under our branding, on the
   page where a user is most willing to act on an instruction about money.
5. **The five codes are legacy's, verbatim, and are checked against their
   source.** `INVALID_PARAMS`, `TRANSACTION_NOT_FOUND`,
   `GATEWAY_CONNECTION_ERROR`, `VERIFICATION_FAILED`, `SYSTEM_ERROR` each have
   a `common.paymentResult.failure.*` key. `payment-result.test.ts` reads the
   `CallbackFailureCode` union out of the service that sends them, so a code
   renamed on that side fails here instead of rendering a blank card.
6. **This is the one place the panel writes a sentence for a backend
   failure.** [contract.errors.md](contract.errors.md) holds the opposite rule
   because `auth-api` translates before it answers — but no call of ours was
   answered here. A bank redirected a browser, and a code is all it carried.
7. **The query string is read on the server.** Both pages are the end of a
   redirect, so their params exist before the first paint and
   `useSearchParams` would only buy a `Suspense` boundary whose fallback is the
   first thing a paying user sees. Legacy had exactly that.
8. **Neither page adjusts a balance.** The top bar re-reads on this load like
   any other ([contract.shell.md](contract.shell.md) rule 1, the wallet
   control's): a redirect from a bank is a fresh document, so there is nothing
   to tell and nothing to add up.
9. **No support link.** `support` has no page (`_lib/panel-menu.ts`), and an
   entry with no page is hidden rather than made a dead link
   ([contract.shell.md](contract.shell.md) rule 2). Legacy's failure screen
   linked to one anyway. The failure page offers the top-up page and the panel.

10. **Only a signed outcome is shown (2026-09-13).** The query string used to
   be the outcome, so `/payment/success?ref=X` typed by hand showed a paid
   top-up. The callback now sends `?t=<base64url JSON>.<HMAC-SHA256>` under
   `PAYMENT_RESULT_SECRET` (billing `payment-result-token.ts`), expiring in 15
   minutes; `_lib/result-token.ts` verifies it on the server with a
   constant-time compare. No token, a bad MAC, an edited body, an expiry, a
   success token on the failed page or no secret configured is a redirect to
   `/financial` — never a guess. The payload still passes rules 2–4's readers.
   The secret is server-only (`env.ts`, no `NEXT_PUBLIC_` mirror). Not bound to
   a user: a real token forwarded within 15 minutes shows a real payment. A
   reload after expiry lands on `/financial`, where the row is.

## What these pages do not do

No amount, no wallet figure, no gateway name: the redirect carries none of
them, and this app does not fetch a payment to decorate a page it cannot
change. The financial page is where a top-up attempt is looked at in full
(F-093-d), and it shows the same reference. No animation library — rule 6 of
[contract.shell.md](contract.shell.md) earns framer-motion for an exit, an
`auto` height or an imperative gesture, and a card that mounts once has none.

The motion (2026-09-13) is CSS keyframes in `globals.css` (`pay-*`): ring and
mark draw, the emblem pops (success) or shakes once (failure), and a fresh
success adds waves and confetti — never on `?already=1` (rule 3). Colours are
theme tokens only, never gold. Every resting style is the final state, so
`prefers-reduced-motion` switches animation off and shows the finished page.
The confetti comes from `_lib/celebration.ts` with a fixed seed: the page is
server-rendered, and a `Math.random()` burst would fail hydration.

## Known gap

These pages sit inside `(panel)`, so a session that expired during the trip to
the bank is a login redirect and the query string is lost. The payment itself
is unaffected — it settled before the redirect — and the reference is on the
financial page. Making them public would mean a result page that cannot say
whose payment it is, so the fix belongs at the guard instead — and landed
there: **F-093-i** (ADR-0042) teaches the login redirect to remember the path it
bounced from, in `sessionStorage`, as a relative path and nothing else. A payer
whose session expired at the bank now signs in and arrives back on this page,
with the reference still on the query string. Nothing on these two pages
changed.

## Proof

`payment/_lib/payment-result.test.ts` — the code list against the service's own
union, the paths against the controller's `RESULT_PATH`, every key these pages
can reach against the shipped `en` and `fa` content, rules 2, 3 and 4 as
cases, and the confetti as deterministic, outward and token-coloured.
`payment/_lib/result-token.test.ts` — rule 10: tokens minted by billing's own
signer are shown; a foreign key, an edited body, an expiry, garbage and an
empty secret are all `null`.
