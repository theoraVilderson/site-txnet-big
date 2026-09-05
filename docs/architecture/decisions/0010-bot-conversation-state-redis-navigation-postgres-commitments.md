---
id: adr-0010
status: accepted
updated: 2026-09-05
---

# ADR 0010 — Bot conversation state: Redis holds navigation, a domain row holds commitments

- **Status:** accepted
- **Date:** 2026-09-05
- **Affects units:** bot-app, redis-keyspace, billing, catalog, support

## Context

A bot flow is a state machine spread over minutes or hours. Somewhere it must
remember what the user is doing. The two obvious homes are both wrong on their
own:

- **Redis only.** Cheap, TTL'd, consistent with ADR-0007 (OTP truth is Redis)
  and with how sessions already work. But a user who picked a plan, saw a price
  and was about to pay loses that when the key expires or the service restarts —
  and *the user does not know they lost anything*. They come back to a main
  menu. Money-adjacent state that vanishes silently is a support ticket, and §9
  makes it blocking rather than a default.
- **Postgres only.** Nothing is lost, but now every keypress in a menu is a
  write. A bot that survives §10.4's traffic cannot put "the user is on screen 3
  of the catalog" in a durable table.

The user's instruction was to combine the two (2026-09-05). The useful question
is therefore not *which store* but *where the line is* — and a line drawn by
"is it important?" will be re-argued on every flow.

## Decision

We will split by **what the user would notice losing**, and the line is drawn
once, structurally:

**Navigation state lives in Redis, under `redis-keyspace`, with a TTL.** Which
screen, the breadcrumb back to the previous one, a half-typed input, the last
`BotView` rendered. Losing it is *recoverable by the user in one tap* — the flow
re-enters at a menu. This is the only state `bot-app` itself holds.

**The moment a flow produces a commitment, it stops being conversation state and
becomes a row in the domain that owns it** — a draft order in `billing`, an
uploaded receipt, a ticket with an attachment in `support`. `bot-app` then keeps
only that row's id in its Redis navigation state. It does not own the row, does
not own a table (`owns_tables: []`), and does not define what a draft order
means.

The test, applied per flow before it is written: *if this evaporates, does the
user have to redo work, or does a domain have something to reconcile?* Either
answer means it was never conversation state.

## Consequences

- **Positive:** the durable half is owned by the domain that already has rules
  for it, so a bot-created draft order and a panel-created one are the same row —
  which is ADR-0009's whole point, now true for in-progress work too. A restart
  costs a menu, never a cart. Redis stays small and TTL'd.
- **Negative / accepted cost:** two stores in one flow, and the handoff point is
  a design decision on every §10.4 feature rather than a default. A flow author
  who skips the test defaults to Redis and reintroduces the silent-loss bug.
- **What this forecloses:** `bot-app` owning tables of its own; a
  "bot_cart"/"bot_session" table that duplicates what `billing` already models;
  treating the bot's in-progress work as private to the bot.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Redis only, longer TTL | moves the silent loss rather than removing it, and a long TTL on money-adjacent state is worse: the user comes back to a stale price |
| Postgres only | a menu keypress is not a durable fact; write volume for no benefit |
| A `bot_session` table owned by `bot-app` | duplicates `billing`'s draft order; the bot's cart and the panel's cart become two things that must be reconciled — exactly the drift ADR-0009 exists to prevent |
| Let each flow choose | the line gets re-argued per flow and lands differently each time; the failure mode is invisible until production |

## Revisit trigger

A flow appears whose in-progress state is genuinely both high-volume *and*
unrecoverable — the test then has no good answer and the split needs a third
tier (a durable queue, or event-sourced conversation state).
