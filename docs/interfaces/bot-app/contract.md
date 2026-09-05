---
id: bot-app
layer: interface
status: draft
version: 1
updated: 2026-09-05
---

# bot-app — contract

**Nothing here is implemented.** This is intent (§0 authority level 4), derived
from ADR-0009 and §10.4 of the catalog. Resolve any feature id with
`python3 tools/spec.py <F-id>`.

## TL;DR

A bot screen is a `BotView`. A bot flow is a state machine over `BotView`s. The
flow never names Telegram or Bale, and never decides anything a domain owns.

## `BotView` — the unit of a bot screen

The abstraction that makes "write once, two UIs" true rather than aspirational.
A `BotView` describes **intent**, not a widget:

| part | holds | never holds |
|---|---|---|
| body | i18n keys + interpolation values | resolved Persian/English strings |
| actions | a list of choices, each with a stable id | a Telegram `reply_markup` |
| media | what to show and at what fidelity | a `file_id` or an upload payload |
| escape | the `panel-web` route that does this better, if any | a hard-coded URL |

`messenger` renders it, consulting that platform's capabilities. Because a
`BotView` lists *choices* rather than a keyboard, the same view survives
degradation to a numbered text list (`F-302`) with no change in the flow.

**Chat-first (ADR-0009, user directive).** Every capability must be completable
in a plain chat conversation on both platforms. `escape` is an *enhancement* the
renderer may offer alongside a working flow — "or open it in the app" — never the
only way to reach a capability, and never a reason a chat flow was skipped. A
`BotView` whose chat path is empty because `escape` is filled in is a bug.

The Mini App (`F-310`) is `panel-web` with a shared session — never a third UI.
Both Telegram and Bale have a WebApp surface, so this is a product choice, not a
platform limit.

## The rule that matters more than the rest

**This unit decides nothing.** It calls `auth-api` (and the service APIs that
follow it) exactly as `panel-web` does. Every §10.4 feature is a panel capability
reached from another surface:

| feature | the decision belongs to |
|---|---|
| `F-303` register/login in the bot | identity |
| `F-304` catalog, invoice, payment | catalog + billing |
| `F-305` one-click renewal/top-up | network + billing |
| `F-306` wallet, history, invoices | billing |
| `F-309` two-way tickets | support |
| `F-311`/`F-312` reseller + sub-reseller management | tenant |
| `F-313` bulk sending | notification (queue) + messenger (limits) |
| `F-318` channel-membership trial gate | engagement/governance decides eligibility; bot only asks the platform for membership |
| `F-319` per-user notification settings | governance |
| `F-1531` reseller business summary | tenant reporting |

If a bot flow needs a rule that no domain exposes, the missing piece is a domain
contract — **not** a rule written in the bot because it is faster there
(ADR-0009, forecloses).

## Conversation state (ADR-0010)

Split by what the user would notice losing:

- **Navigation state → Redis, TTL'd** (`redis-keyspace`): current screen, the
  breadcrumb back, a half-typed input, the last `BotView`. Losing it costs the
  user one tap. This is the only state this unit holds.
- **A commitment → a row in the domain that owns it**, the moment it becomes
  one: a draft order in `billing`, a receipt, a ticket with an attachment in
  `support`. This unit keeps only the row's id in its navigation state. It owns
  no tables (`owns_tables: []`) and does not define what a draft order means.

The test, applied **before** a flow is written: *if this evaporates, does the
user have to redo work, or does a domain have something to reconcile?* Either
answer means it was never conversation state. A flow that skips the test
defaults to Redis and reintroduces the silent-loss bug ADR-0010 exists to
prevent.

## Session

The bot's user is the same `User` as the panel's, proven by a
`LinkedBotAccount` with `contactVerifiedAt` set (`identity`, invariant #12). The
bot does not invent an identity model and does not hold credentials: it obtains a
session the same way, and the Mini App shares it (`F-310`). A messenger chat id
is **not** an authentication.

## Deep links (`F-314`)

`?start=<payload>` is the bot's URL bar: `buy_<sku>`, `ref_<code>`, `trial`, plus
the existing `F-0203` link token. One parser, one place, and an unrecognised
payload lands on the main menu rather than failing — the payload comes from
outside and is untrusted input, not a command.

## Text and branding

Every string is an i18n key resolved through `i18n`. `F-317` makes bot text,
menus, emoji and buttons overridable **per tenant**, so no copy may be inlined in
a flow, not even a fallback. RTL/LTR and numeral localization are `i18n`'s job
(§1.5), not the bot's.

## Consumers

None. This is a leaf surface: things call *out* of it, nothing calls into it
except `messenger` handing over a normalized update.

## Open

See [open-questions.md](open-questions.md).
