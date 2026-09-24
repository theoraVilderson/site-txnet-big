---
id: bot-app
layer: interface
status: active
version: 13
updated: 2026-09-20
---

# bot-app — contract

`F-303`, `F-311-c` and `F-313-b` are implemented; the rest of §10.4 is intent
(§0 level 4), from ADR-0009. Resolve an id with `python3 tools/spec.py <F-id>`.

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
Both messengers have a WebApp surface, so that is a product choice, not a
platform limit. **Built** 2026-09-08: see § The Mini App below.

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
| `F-311`/`F-312` reseller + sub-reseller management | tenant — the users and the two writes `auth-api` (F-311-a), the figures billing (F-311-b), **and whether the chat may see any of it at all** the door (F-311-e). The flow is built: [contract.reseller.md](contract.reseller.md) |
| `F-313-b` bulk sending | notification — the audience, the count, the draft and the send (F-313-d over F-035-d/e) + messenger (the ceiling, F-313-a/ADR-0066). The flow is built: [contract.reseller.md](contract.reseller.md) |
| `F-318` channel-membership trial gate | engagement/governance decides eligibility; bot only asks the platform for membership |
| `F-319` per-user notification settings | governance |
| `F-1531` reseller business summary | tenant reporting |

If a bot flow needs a rule that no domain exposes, the missing piece is a domain
contract — **not** a rule written in the bot because it is faster there
(ADR-0009, forecloses).

## What is built (`F-303`)

| file | holds |
|---|---|
| the front door — `webhook/**`, `common/service-only.guard.ts` | the route, what it verifies, and why it now publishes the update instead of running it (F-067-b): [contract.webhook.md](contract.webhook.md) |
| `conversation/router.ts` | `/start` (+ `F-314` payload), `/logout`, cancel, and reading a *typed* answer back to a choice |
| `conversation/bot.dispatcher.ts` | render for this platform, send, delete the password message, remember the screen |
| `flows/otp.step.ts` | the channel question, the cross-messenger link, the in-place link |
| `flows/{login,register,forgot}.flow.ts` | the three conversations |
| `flows/phone-number.ts` | the number a person typed or shared, read into the form `auth-api` stores |
| `flows/steps.ts` | which step of how many, and what has been answered — orientation only, no rules |
| `locale/chat-language.ts` | which language this chat is spoken to in, and the order that decides it |
| `session/bot-session.store.ts` | the chat's `auth-api` refresh token |
| `session/chat-access.ts` | that refresh token traded for an access token, for the routes behind `AuthGuard` |
| `session/account-switcher.ts` | becoming another account and keeping the chat's session on it — the one place that pair happens |
| `flows/accounts.flow.ts` | the switch group, and becoming another member of it (`F-0210`) |
| `flows/views.ts` `miniApp()` | the Mini App as a row on the member menu (`F-310`) |
| `flows/account-add.flow.ts` | an account joining that group, by one of `F-0205`'s two proofs |
| `auth-api/auth-api.client.ts` | the only way out — to identity |
| `flows/top-up.flow.ts`, `billing-api/billing-api.client.ts` | the wallet top-up, and the way out to billing (F-306-a, below) |
| `flows/reseller.flow.ts` + `reseller-campaign.flow.ts`, `tenant-api/` + `notification-api/` clients | the reseller panel — menu row, customers, block, revenue (F-311-c) and its bulk message (F-313-b): [contract.reseller.md](contract.reseller.md) |

**The bot reaches `auth-api` with a service credential** (`X-Service-Token`,
ADR-0011): it waives the slide captcha — a chat cannot drag one — and moves the
rate-limit bucket from the IP to the chat. It authenticates no user.

## Signing in is not an OTP flow any more (ADR-0012)

A chat holding a contact-verified `LinkedBotAccount` **is** a credential, so
`LoginFlow.start` trades it for a session (`POST /auth/bots/session`) before
asking anything: one tap, or one tap plus the contact card. No phone, no code.

The rule is `identity`'s — this unit only knows which screen comes next, and
must not treat the fast path as the *only* path: a refusal
(`auth.botFactorNotAllowed`, or no account on that number) opens the ordinary
method screen with `auth-api`'s reason as its `hint`. Falling through is the
rest of the conversation, not an error state. Register, password-reset and
signing into an account this chat does not own still need a code.

## Where the code goes (`F-303`, the question this feature exists to answer)

After the phone is known, `GET /auth/otp/channels` supplies them, offered in
this order: **this chat**, then **SMS** if the environment has it, then **the
other messenger** (Bale from Telegram, Telegram from Bale).

Every channel is named after itself. ADR-0012 deleted the "here, in this chat"
label: the code goes to whichever chat owns the **typed** number, so it was
true by coincidence and wrong whenever that number belonged to another chat.

An unlinked messenger answers with the ordinary `linkRequired` shape
(`F-0202`/`F-0203`), rendered two ways: **the other messenger** gets its deep
link plus "I have done that" (polling `POST /auth/bots/link/status`); **this
chat** needs no round trip — `link/resolve` binds it, the user shares their
number, `link/contact` proves it. The proof itself never moves:
`contact.user_id === message.from.id` plus a phone match stays in `identity`
(invariant #12).

## The number, from any country (`F-062`, ADR-0018)

A chat has no country picker, so `flows/phone-number.ts` does the panel's job:
a number naming its own country is kept (`+49…`, `0049…`, a shared contact
whose `+` the messenger dropped), a bare one belongs to the deployment's region
(`DEFAULT_PHONE_COUNTRY`, else the bot's language). It **spells** a number and
never judges one — unreadable input travels on untouched and returns as
`auth-api`'s refusal. A bare *foreign* national number needs a country step:
a screen, and a decision of its own.

**The conversation shell** — orientation, Back, the language a chat is spoken
to in, and the commands — is [conversation.md](conversation.md). It applies to
every flow, including the §10.4 flows not yet written.

## The Mini App (`F-310`, ADR-0017)

One row on the member menu, and this unit's whole share of the feature. The row,
the three decisions that live here rather than in the panel, and the marker the
URL carries are in [contract.mini-app.md](contract.mini-app.md).

## Top-up (`F-306-a`, `F-104-m`)

Gateway → amount → billing's quote (`topUp.quote`; `topUp.quoteTaxed` adds the tax line when billing's `tax` is not zero, ADR-0076, F-104-ai) → `start` → a bank `url` button, the credit (free), or an **invoice** (in-chat gateway: `FlowResult.invoice`, sent after the screen, with the `providerToken` billing answered — Bale's wallet, F-104-n).
Billing's deposit routes **through the gate** (`BILLING_API_BASE_URL`), chat access token as Bearer; `X-Service-Token` records the `bot` channel,
`X-Bot-Platform` + `X-Bot-Tenant-Id` (believed only beside it) offer an in-chat gateway only for **this bot's tenant's** payment — the owner in their reseller's bot pays the platform, and the Stars would reach the reseller's bot (F-061-j). Every number is billing's; it ends at `start`.
A payment event (`ChatContext.payment`) never reaches a flow: `InChatPayment` relays it to billing's `internal/.../in-chat/*` (`BILLING_INTERNAL_BASE_URL`, service token, no session) with the sender and this bot's tenant; billing admits only the payer (F-104-ab). Every
`pre_checkout_query` is answered — refusals as `topUp.refused*`, billing-down included — since an unanswered one is cancelled in 10 s.
`successful_payment` → `paidCredited`, or `paidPending` if nothing credited; billing marks that credit `shownInChat`, so the payer notice stays silent.

## The switch group (`F-0205`, `F-0207`, `F-0210`)

Moving between the accounts a chat holds, whose set it is, and how an account
joins it — all of it in [contract.accounts.md](contract.accounts.md).

## Passwords in a chat

The register / login / reset password is typed in the chat and the message is
deleted the moment it is spent (ADR-0011) — both platforms allow this for 48 h
(`messenger/capabilities.ts`, verified 2026-09-06). A failed delete is **told**
to the user; silence would leave them believing it is gone. A password is never
written to Redis: `ConversationStore` strips it even if a flow tries.

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
user redo work, or does a domain have something to reconcile?* Either answer
means it was never conversation state — and a flow that skips the test defaults
to Redis and reintroduces the silent-loss bug ADR-0010 exists to prevent.

## Session

The bot's user is the same `User` as the panel's, proven by a
`LinkedBotAccount` with `contactVerifiedAt` set (`identity`, invariant #12). It
invents no identity model and holds no credential: only the ordinary `auth-api`
refresh token, in the `bot:session:` entry `redis-keyspace` catalogues — one per
bot per chat, never per chat alone (F-320). A password reset and a self-removal
(`F-0208`) each revoke it at `auth-api` and drop the entry. `/logout` no longer
always does: since ADR-0035 it signs out of **one** account, and when this
place still holds another the answer carries *that* account's session — which
the chat keeps, staying signed in as them. Signing out of everything is its own
action on the accounts screen (`F-0211`), two taps, because the tap that opens
the question must not be the tap that answers it.

**A messenger chat id is not an authentication.** Without that Redis entry the
chat is anonymous, however well known its owner is, and `/start` shows the guest
menu.

**And the entry alone is not one either** (ADR-0033, 2026-09-10). It is a local
cache, and it cannot know the session behind it was revoked somewhere else — a
Mini App logout, an `F-0208` removal, thirty idle days. So which menu a chat
sees is decided by `ChatAccess.token()`, which refreshes first and drops the
entry when `auth-api` refuses, and never by the entry's presence. That costs a
menu render one round trip; the alternative is a member menu shown to someone
who is signed out, failing on their first tap.

## Deep links (`F-314`)

`?start=<payload>` is the bot's URL bar: `buy_<sku>`, `ref_<code>`, `trial`, plus
the `F-0203` link token. One parser, one place; an unrecognised payload lands on
the main menu rather than failing — it is untrusted input, not a command.

## Text and branding

Every string is an i18n key resolved through `i18n`. `F-317` makes bot text,
menus, emoji and buttons overridable **per tenant**, so no copy may be inlined in
a flow, not even a fallback. RTL/LTR and numerals are `i18n`'s job (§1.5).

**Voice** (user decision, 2026-09-07). Persian is «شما» with spoken verbs —
«شما می‌تونید…», «لطفاً رمزتون رو بفرستید» — polite, not stiff. English keeps the
same register: plain, second person. One idea per message, and no mechanism
unless the user has to act on it: `accounts.addAskPhone` still says the code
goes to *that* number because the user goes looking for it, while the old
«باید ثابت کند مال شماست» explained a security model nobody asked about. Emoji
discipline: one, at the end, on success.

**Three files, one key set.** A key lives in `fa/bot.json`, `en/bot.json` and
`bot-copy.fallbacks.ts` (the last-resort English) — never in two of the three.
Values may be rewritten freely; **a key may never be renamed**, because the
flows and `views.ts` cite it by name and a miss renders it raw instead of
failing. Same trap in a *value*: a word this bot owns (a status, a channel) is
nested as a `BotText`, `{ key: … }`, or it too is spliced in raw and nothing
fails. `bot-copy.spec.ts` holds the three files, their placeholders and the keys the code asks for to one set.

**A failure is a sentence, never a key.** An `AuthApiClient` `msg` renders as
`BotText.raw`, never translated again — so the answers `auth-api` did not
translate (no answer, a non-JSON body, no `msg`) are resolved in `ctx.lang`.

## Consumers

`automation`. Since F-067-b the webhook enqueues and `worker-service` runs the
flow by calling `internal/bots/dispatch` ([contract.webhook.md](contract.webhook.md)).
Otherwise this is still a surface things call *out* of.

## Open

See [open-questions.md](open-questions.md).
