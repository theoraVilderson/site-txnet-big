---
id: adr-0042
status: accepted
updated: 2026-09-12
---

# ADR 0042 — A bounced deep link is remembered as a relative path, in the tab

- **Status:** accepted
- **Date:** 2026-09-12
- **Affects units:** panel-web

## Context

The panel's session guard answers every failed session with
`router.replace(AUTH_LOGIN)`. That call carries no path and no query, so the
destination the visitor was going to is simply gone: they sign in and land on
the panel home, with no way back to what they clicked.

F-093-f is the first place this costs something a user can see — a payer
returning from a bank on an expired session loses the reference number off the
screen — but it is not a payment problem. A link from the bot, a link in an
email, a link to one invoice and a bookmarked page all land the same way, and
every deep link the panel grows from here inherits the behaviour.

Two things make the fix a decision rather than a patch.

**Where the destination is kept is a security question.** The usual shape is
`?returnTo=<path>` on the login URL, and an unchecked `returnTo` on a sign-in
screen is the classic phishing vector: a link that walks a user through *our*
login form and then hands them to somebody else's page, with our domain in the
address bar for the whole of the trust-establishing part.

**Where the fix lives decides how many places have to get it right.** The
destination is known at exactly one moment — when the guard discovers there is
no session — and needed at exactly one other: when a sign-in screen finishes.

## Decision

1. **The destination is stored in `sessionStorage`, never in the URL.** The
   redirect is client-side and in the same tab, so a per-tab store is enough.
   It keeps a payment reference out of a second URL, out of browser history and
   out of every log that records one, and — the point — it leaves nothing an
   outside link can forge, which a `?returnTo=` parameter is by construction.
2. **A stored destination is a relative path and nothing else.** It must begin
   with exactly one `/`; it may not begin with `//`, contain a backslash, or
   contain whitespace or control characters. It is validated when it is written
   **and again when it is read**, and anything that fails is dropped in favour
   of the panel home rather than corrected.
3. **The rule lives at the guard, in one module.** `lib/return-to.ts` owns the
   validation, the store and the consumption; the guards call
   `rememberReturnTo`, the sign-in screens call `consumeReturnTo`, and no page
   knows a destination was ever remembered.
4. **Reading consumes it, and a deliberate sign-out clears it.** An intent
   outlives nothing: the next person to sign in on that tab must not land on
   the previous one's payment page.

## Consequences

- Every future deep link into the panel survives an expired session, with no
  work on the page that owns it. The pages F-093-f built do not change.
- The one risk added is the forged-destination one, and it is bounded by rule 2
  to a same-origin path. This guard is a **UX redirect and not a boundary** —
  the panel's Traefik router carries no `my-auth`, and the real gate is on the
  API (ADR-0037) — so nothing here decides what anybody may see.
- A browser with `sessionStorage` unavailable (a private window, blocked site
  data) degrades to exactly the behaviour before this decision: the panel home.
  Every access is wrapped, and a failure is not an error path.
- The server-side auth-screen guard in `src/proxy.ts` cannot participate: it
  runs before any script and cannot read the tab's storage. A signed-in visitor
  who opens `/auth/login` is therefore still redirected to the panel home, with
  a stored intent left behind. It is bounded — the next bounce overwrites it and
  a sign-out clears it — and making it participate would mean putting the path
  back in the URL, which is the thing rule 1 refuses.

## Alternatives considered

- **`?returnTo=` on the login URL.** Rejected: forgeable from outside by
  design, and it puts a payment reference in a URL, in history and in logs.
- **Making the result pages public.** Rejected in `contract.payment-result.md`
  already: a result page that cannot say whose payment it is.
- **Remembering it per page, where the deep link is known.** Rejected: the
  destination is lost at the guard, so every page would have to re-implement
  the same rule, and the one that forgot would be the one nobody tested.
