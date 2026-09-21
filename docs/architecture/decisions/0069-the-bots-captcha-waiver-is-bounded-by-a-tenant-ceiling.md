---
id: adr-0069
status: active
updated: 2026-09-21
---

# ADR 0069 — the bot's captcha waiver is bounded by a tenant ceiling

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** auth-api, bot-app, redis-keyspace

## Context

ADR-0011 waives `CaptchaGuard` for a proven service caller, and it is right to:
a bot cannot drag a slider, and a chat challenge is a tap, which proves nothing.
It also wrote down what the waiver costs — *"the rate limits, not the captcha,
are then the only thing between an attacker and these routes"* — and left it at
that, because the limits looked sufficient: `rateLimitSubject()` swaps the IP for
`bot:<chatId>`, so one chat gets a login's worth of budget and not the whole
bot's.

**What that reasoning missed is what a chat costs.** A chat id is a messenger
account, and a messenger account is a phone number and five minutes. Every
counter protecting the waived routes is keyed on something the attacker chooses
and can buy again: fifty Telegram accounts is fifty full budgets. The captcha
was the one control on those routes whose price did *not* fall with volume, and
for the bot it was removed with nothing of that shape put in its place. The user
reported it in exactly those words on 2026-09-21: *"یارو میتونه یه اکانت telegram
بسازه باهاش کلی اکانت لاگین کنه"*.

The difficulty is that the obvious subject for a ceiling — "this chat is new" or
"this chat is not contact-verified" — is a fact `auth-service` does not hold on
the credential routes, and buying it means a lookup on every bot call to the
busiest paths on the service.

## Decision

We will bound the waiver with **one rate-limit budget per tenant, counted only
where the captcha is waived**: `RateLimitBucket.BOT_UNPROVEN`, spent inside
`CaptchaGuard` at the moment it decides to let a service caller through, over
exactly the routes carrying `@RequireCaptcha` and no others.

The budget carries **no subject at all** — the key is the tenant's alone, the
shape `ROLE_WRITE` already uses. That is the whole point: a subject an attacker
can multiply cannot bound an attack whose cost is multiplication.

**The routes are the filter, so no lookup is needed.** A chat that is already
signed in never reaches a gated route: the bot's fast path answers from
`POST /auth/bots/session` (ADR-0012), which is not gated and does not count. So
the budget is spent by sign-ins, registrations and password resets *started* in
a reseller's bot — not by its customers' ordinary use — and "unproven" is a
property of the route rather than something anyone has to look up.

## Consequences

- Positive: the waiver's price no longer falls with the number of messenger
  accounts an attacker holds. Fifty fresh chats share one budget where they
  previously brought fifty.
- Positive: it lands in one place, at the exemption itself, so a route gated in
  future inherits the ceiling the day it is gated — and the reverse is true too,
  which `captcha-coverage.spec.ts` is what pins.
- Negative / accepted cost: it is a shared budget, so a determined attacker can
  spend a reseller's bot sign-in allowance and make legitimate bot sign-ins fail
  for the rest of the window. That is a denial of one surface, not of the
  account: the panel is untouched and has its own captcha. The mitigation for
  the legitimate user caught by it is the open question below.
- Negative: the number is an operations decision, not a derivation.
  `BOT_UNPROVEN_RATE_LIMIT` defaults to 120 per 900s per tenant, which is
  generous for today's resellers and is a guess for a large one. It is env
  config for that reason.
- What this forecloses: nothing about a real proof-of-humanity signal. If a
  messenger ever ships one, ADR-0011's revisit trigger still applies and this
  ceiling becomes a backstop rather than the only control.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A captcha step rendered in the chat | ADR-0011 rejected it and the reason has not changed: a tap is not a proof of humanity, so it buys the shape of the control without its substance — and here it would not even help, since an attacker who registers fifty accounts taps fifty times |
| Key the ceiling on "this chat is new / not contact-verified" | the honest subject, and `auth-service` does not hold that fact on the credential routes. Buying it means a lookup on every bot call to the busiest paths on the service, or trusting a header `bot-service` asserts. The routes already separate proven traffic from unproven, for free |
| A per-platform or per-bot sub-bucket under the tenant | catalog 2.6 uses that shape for the *webhook* limit, where the point is that one bot cannot starve another. Here the point is the opposite: the budget must not be divisible, or an attacker picks the emptier bot |
| Count it platform-wide as well (F-066-s) | the subject is a tenant rather than a caller, so one reseller's attacker would shut every other reseller's bot sign-in — `LOGIN_FAILURES`' reason exactly |
| Leave it and rely on the per-victim limits (`LOGIN_FAILURES`, `OTP_PHONE`) | those bound what any one *victim* suffers, which is most of the harm and is why F-0201-b came first. They say nothing about breadth: one attacker touching ten thousand numbers is within every per-victim limit there is |

## Revisit trigger

Either of:

- A legitimate reseller hits the ceiling in normal use. That is a number
  problem first (`BOT_UNPROVEN_RATE_LIMIT`), and a shape problem only if raising
  it far enough to serve them stops bounding anything.
- The ceiling's refusal stops naming a reason, or a second reason wants the
  same treatment. **Closed on the day this was written** (F-0201-d, user's
  call): a throttled chat is offered the Mini App, and the bot tells that
  refusal from any other by `error.reason === 'botTrafficThrottled'` — the
  mechanism ADR-0043 already built for exactly this. No status code is read, so
  ADR-0009's rule that `AuthApiClient` "never inspects a status code — `ok` is
  the answer" is intact, and `bot-app/contract.mini-app.md` holds the rule.
