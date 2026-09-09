---
id: bot-app
layer: interface
status: active
version: 10
updated: 2026-09-09
---

# bot-app — contract

`F-303` is implemented (`txnet-backend/bot-service/`); the rest of §10.4 is
intent (§0 authority level 4), derived from ADR-0009 and the catalog. Resolve
any feature id with `python3 tools/spec.py <F-id>`.

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
platform limit. It is **built** (2026-09-08): see § The Mini App below.

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

## What is built (`F-303`)

| file | holds |
|---|---|
| `webhook/webhook.controller.ts` | `POST /api/bots/:platform/:webhookPath` — one unguessable path per bot, and the path is what resolves the tenant (F-320). Unknown path, wrong secret token, or a Telegram request with no header -> 404; known path -> always 200 |
| `webhook/update.normalizer.ts` | the last place that knows what a Telegram `Update` looks like |
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
| `auth-api/auth-api.client.ts` | the only way out |

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

One row on the member menu, `kind: 'web_app'`, pointing at `PANEL_BASE_URL`.
That is the whole of this unit's share of the feature, and the smallness is the
design: the Mini App is `panel-web`, so everything it can do it already does,
and anything this unit added would be the third UI ADR-0009 forbids.

Three decisions live here rather than in the panel:

- **A menu row, not a `BotView.escape`.** An `escape` says "*this screen* is
  done better on the web" — a claim about one screen. The Mini App is a
  destination, so it sits where the other destinations are. Nothing moved into
  it: chat-first holds, and a `BotView` whose chat path is empty because the
  Mini App does it better is still a bug.
- **The member menu only.** A chat with no session is one this bot has never
  signed in; sending it into a webview to find out whether the messenger
  vouches for it there is a worse first answer than the sign-in button it
  already has.
- **No row when `PANEL_BASE_URL` is unset.** A deployment with no published
  panel shows a shorter menu rather than a button that opens nothing.

The page then signs *itself* in: the platform hands it a signed `initData`,
`panel-web` presents that to `POST /auth/bots/webapp/session`, and the session
that comes back is the ordinary one (ADR-0017). This unit is not in that path
at all — it hands over a URL, and the credential is the platform's signature,
never anything this bot passes along. Degradation is the renderer's
(`messenger`): a platform without the WebApp surface gets the same URL as a
plain link.

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
bot per chat, never per chat alone (F-320). `/logout`, a password reset and a
self-removal (`F-0208`) each revoke it at `auth-api` and drop the entry.

**A messenger chat id is not an authentication.** Without that Redis entry the
chat is anonymous, however well known its owner is, and `/start` shows the guest
menu.

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
`bot-copy.fallbacks.ts` (the last-resort English, for a key that ships ahead of
its translation) — never in two of the three. Values may be rewritten freely;
**a key may never be renamed**, because the flows, `views.ts` and that table
cite it by name and a miss renders the raw key instead of failing.
`bot-service/src/app/locale/bot-copy.spec.ts` holds all three to one key set,
one `{{placeholder}}` set, and to the keys the code actually asks for.

**A failure is a sentence, never a key.** An `AuthApiClient` `msg` renders as
`BotText.raw`, never translated again — so the answers `auth-api` did not
translate (no answer, a non-JSON body, no `msg`) are resolved in `ctx.lang`.

## Consumers

None. This is a leaf surface: things call *out* of it, nothing calls into it
except `messenger` handing over a normalized update.

## Open

See [open-questions.md](open-questions.md).
