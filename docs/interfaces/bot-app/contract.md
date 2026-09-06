---
id: bot-app
layer: interface
status: active
version: 7
updated: 2026-09-06
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

## What is built (`F-303`)

| file | holds |
|---|---|
| `webhook/webhook.controller.ts` | `POST /api/bot/:platform/webhook/:secret` — one unguessable path per bot; wrong secret -> 404, known path -> always 200 |
| `webhook/update.normalizer.ts` | the last place that knows what a Telegram `Update` looks like |
| `conversation/router.ts` | `/start` (+ `F-314` payload), `/logout`, cancel, and reading a *typed* answer back to a choice |
| `conversation/bot.dispatcher.ts` | render for this platform, send, delete the password message, remember the screen |
| `flows/otp.step.ts` | the channel question, the cross-messenger link, the in-place link |
| `flows/{login,register,forgot}.flow.ts` | the three conversations |
| `flows/steps.ts` | which step of how many, and what has been answered — orientation only, no rules |
| `locale/chat-language.ts` | which language this chat is spoken to in, and the order that decides it |
| `session/bot-session.store.ts` | the chat's `auth-api` refresh token |
| `session/chat-access.ts` | that refresh token traded for an access token, for the routes behind `AuthGuard` |
| `flows/accounts.flow.ts` | the switch group, and becoming another member of it (`F-0210`) |
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

**The conversation shell** — orientation, Back, the language a chat is spoken
to in, and the commands — is [conversation.md](conversation.md). It applies to
every flow, including the §10.4 flows not yet written.

## Switching accounts (`F-0210`, ADR-0014)

The member menu offers the group: who this chat is signed in as, and who else
it may become in one tap. It is `panel-web`'s switcher (`F-0209`) on a chat —
the same `GET /auth/accounts` and `POST /auth/accounts/switch`, and the same
absence of any credential, because the group is the proof.

**What moves is the session, never the link.** The Redis entry is overwritten;
`LinkedBotAccount` is untouched, so a chat stays linked to one account and
identity invariant #12 stands. ADR-0014's accepted cost follows: after
`/logout` the one-tap sign-in returns to the **linked** account, and reaching
the other one is a switch from there.

**These were the first routes here behind `AuthGuard`**, so they need the
*user's* access token, not only the service credential. `ChatAccess.token`
mints one from the stored refresh token; refreshing **rotates**, so the new
refresh token is written back before anything else, and a refusal means the
session is gone — the entry is dropped and the chat is told so, rather than
failing on a later screen that cannot explain itself.

## The group belongs to this chat (ADR-0015)

Since ADR-0015 a switch group is not a property of the person but of the
surface it was built on, and for the bot that surface is **one chat**. The set
offered above is this chat's alone: the same user may hold a different set in
their browser, and neither is visible from the other.

Two consequences an edit must not undo:

- **Every account call carries `x-bot-platform` beside `x-bot-chat-id`.**
  `auth-api` names the scope `bot:<platform>:<chatId>` and refuses outright
  when the platform is missing — Telegram and Bale number their chats
  independently, so a chat id alone can name two different chats.
- **Removing an account (`F-0208`) removes it here only**, and revokes only the
  sessions minted in this chat. Removing the chat's *own* account is a sign-out
  here: the stored refresh token is dropped, because `auth-api` has already
  revoked the session behind it. The remove path re-reads the group before it
  asks, and again on the confirming tap, so a stale keyboard cannot remove
  someone who has since moved.

## Adding an account (`F-0205`, `flows/account-add.flow.ts`)

The other half of the screen above: this is how an account becomes one of the
set — the panel's add-account page (`accounts/add/page.tsx`) as a conversation,
same routes, same two proofs, same order.

Membership is **proved, never asserted** (`audit` invariant #4), so the whole
conversation exists to carry exactly one credential and the caller picks which:
a code to the **joining account's own phone** (`add/otp/request` then
`add/otp/verify`), or that **account's own password** (`add/password`).

Three properties are not incidental, and an edit should not quietly drop them:

- **It signs nobody in.** All three routes answer with a group id, never a
  token pair, and the flow saves no session: the chat stays as whoever it was,
  and the account that joined is reached afterwards through a switch.
- **The code goes to a phone that is not the person in this chat**, so this is
  the one caller passing `inPlace: false` to `OtpStep.request`. The in-place
  link would bind *this* chat to the joining account, which identity refuses
  (`takenByAnotherAccount`, invariant #12) — so that path could only end in a
  refusal, reached after the user shared a contact card for nothing.
- **The phone is typed, never shared.** `askContact` sends *this* user's number,
  already signed in — its only outcome is `accountSwitch.sameAccount`.

The password message is deleted on every path out of that step, including the
one where the session turned out to be gone.

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
refresh token at `bot:session:<platform>:<chatId>`, 30-day idle TTL — the chat's
equivalent of the panel's cookie. `/logout`, a password reset and a self-removal
(`F-0208`) each revoke it at `auth-api` and drop the entry.

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

## Consumers

None. This is a leaf surface: things call *out* of it, nothing calls into it
except `messenger` handing over a normalized update.

## Open

See [open-questions.md](open-questions.md).
