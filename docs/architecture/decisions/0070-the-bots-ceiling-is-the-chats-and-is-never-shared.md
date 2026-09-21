---
id: adr-0070
status: active
updated: 2026-09-21
---

# ADR 0070 — the bot's ceiling is the chat's, and is never shared

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** auth-api, bot-app, redis-keyspace
- **Supersedes:** [ADR-0069](0069-the-bots-captcha-waiver-is-bounded-by-a-tenant-ceiling.md)

## Context

ADR-0069, one day old, gave `RateLimitBucket.BOT_UNPROVEN` **no subject**: one
budget for a whole tenant's unproven bot traffic over the captcha-gated routes.
Its reasoning is still correct as far as it goes — a chat id is a messenger
account, an attacker buys more of them, and a subject that can be multiplied
cannot bound an attack whose cost *is* multiplication.

It recorded the price of that as an accepted cost, in one line under
Consequences. The user read the line and rejected the trade on 2026-09-21:

> بودجه مشترک است. یعنی مهاجم می‌تواند سهم ورودِ رباتِ یک ریسلر را تا آخر پنجره
> بسوزاند و ورود مشتری‌های واقعی آن ریسلر تا آخر آن پنجره رد شود.

**The objection is about who pays.** A shared budget is spent by whoever gets
there first, and the person it then refuses is not the attacker — the attacker
already got what they came for and stopped. It is the next customer of that
reseller to open the bot, who spent nothing and is refused for the rest of the
window, and who has no way to tell that this is what happened. The defence
charges its whole cost to the people it is defending.

The arithmetic made it worse than it reads. The gated routes allow one chat 20
password logins, 10 code requests, 10 resets and 10 registrations in a 900s
window — 50 calls. Against a tenant budget of 120, **three messenger accounts**
were enough to close a reseller's bot sign-in for a quarter of an hour. The
ceiling that was meant to price an attacker's breadth was cheaper to defeat
than the breadth it was pricing.

A design that kept both properties was offered — meter the budget in *distinct
chats* rather than requests, so a customer costs one unit however many times
they retry, and an attacker costs one unit per messenger account — and the user
declined it too, for load: many customers signing in at once would still meet a
shared number, and a shared number is exactly what they did not want.

## Decision

`BOT_UNPROVEN` is keyed on the acting chat: `rateLimitSubject(request)`, the
same `bot:<chatId>` every other counter a bot call meets. **No budget in front
of the bot is shared between chats.**

`BOT_UNPROVEN_RATE_LIMIT` falls from 120 to 30 per 900s with the subject. A
ceiling above the 50 the gated routes already allow one chat could never bind,
and a counter that cannot bind is worse than none: it reads in the registry as
a control and is not one.

The bucket is kept rather than deleted. It is the one **cross-route aggregate**
in front of the waived routes — the per-route limits bound one chat on one
route, and this bounds one chat across all of them, which is what a chat
spreading its attempts over login, forgot and register would otherwise walk
straight through.

## Consequences

- Positive: no legitimate sign-in is ever refused because of traffic that is
  not its own. This is the whole point, and it is a property, not a tuning: a
  per-chat counter cannot be exhausted by anybody but its own chat.
- Positive: the number is now about one person, so it can be reasoned about.
  30 attempts in 15 minutes from one chat is an order of magnitude above what a
  customer does and well under what the routes separately allow.
- **Negative, and stated plainly rather than left implied: breadth is now
  unbounded here.** An attacker with N messenger accounts gets N budgets, which
  is exactly what ADR-0069 set out to stop and what the user reported on
  2026-09-21 as *"یارو میتونه یه اکانت telegram بسازه باهاش کلی اکانت لاگین
  کنه"*. What still bounds that attack is what bounded it before ADR-0069:
  `OTP_PHONE` (5 codes per number per hour) and `LOGIN_FAILURES` (per identity),
  both keyed on the **victim** — so what any one person suffers is bounded, and
  the number of people an attacker may touch is not.
- Negative: the platform-wide ceiling (F-066-s) does not cover the gap either.
  It scales from the route's limit and is keyed on the caller, so N chats is
  still N budgets under it.
- What this forecloses: nothing. If breadth has to be priced again, it needs a
  control whose cost does not fall with the number of messenger accounts — a
  real proof-of-humanity signal from the messenger (ADR-0011's revisit
  trigger), or a per-chat admission a chat pays once. A shared counter is not
  that control and this decision says so.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep ADR-0069's tenant budget | the user rejected the trade explicitly, and the arithmetic above is why they were right to: three messenger accounts closed a reseller's bot sign-in for a window, and every refusal it bought fell on somebody who had spent nothing |
| Meter the tenant budget in distinct chats rather than requests | offered, and the stronger of the two shared designs — a customer would cost one unit however many times they retried, and an attacker one unit per account, raising the three accounts above to 120. Declined by the user (2026-09-21): a shared number is still a shared number, and a reseller with many customers signing in at once would meet it |
| Delete the bucket entirely | the per-route limits would then be the whole defence, and a chat that spreads its attempts across login, forgot and register meets none of them. The cross-route aggregate is the part of ADR-0069 worth keeping, and keeping it costs one Redis counter |
| Keep 120 with the chat as the subject | the gated routes already allow one chat 50 calls in the window, so the ceiling could never fire. It would be a line in the registry that looks like a control |
| Reserve part of a shared budget for chats already mid-flow | still a shared budget, so still refuses somebody who spent nothing — just later. It also leaves two numbers to tune where the objection was to having one |

## Revisit trigger

Either of:

- Breadth is attacked in production — many fresh chats at one reseller's bot,
  visible as a spike in `bot:unproven` counters across distinct subjects. That
  is the cost above arriving, and it is a decision to reopen with the user,
  naming what the shared alternatives would have cost them.
- A messenger ships a real proof-of-humanity signal. ADR-0011's trigger still
  stands, and such a signal is the control this decision says is missing.
