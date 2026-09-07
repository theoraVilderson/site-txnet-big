---
id: bot-app
layer: interface
status: active
version: 1
updated: 2026-09-06
---

# bot-app — the conversation shell

What is true of **every** screen, whichever flow produced it. A flow returns
only what happens next; everything here is applied to that result centrally, so
a flow cannot ship without it and a §10.4 flow not yet written gets it free.

## Orientation — the router decorates, the flow does not

A chat has no title bar, no progress indicator and no form to scroll back
through, so a flow that asks six questions without saying which six — and
answers a rejection with a sentence and an empty keyboard — is one users get
lost in. That was never fixable one call site at a time.

A flow returns only *what happens next*; `ConversationRouter.decorate` turns it
into a screen a reader can place themselves on. Five rules, applied to every
result, including every §10.4 flow not yet written:

| rule | what it prevents |
|---|---|
| a view with words and no choices becomes the `hint` on the screen the user is *actually* on (its `lastView`) | a rejected password leaving a chat with no keyboard on it, or "choose one of the options above" printed over a screen that has none |
| the step advances -> the state before it is pushed onto `NavState.history` | one mistyped letter costing the whole conversation |
| `header` = which flow, step `n` of `total` (`flows/steps.ts`); `summary` = the answers already given | a user four questions in with no idea how many are left or what the bot thinks they said |
| Back joins Cancel once there is history | a flow having to implement Back, which is a second copy of the flow |
| a result with `nextState: null` **and no choices of its own** gets the menu — body as `footer`, choices as `actions` | a conversation ending on a statement and nothing else. A terminal screen that *does* have choices (the language chooser, help) keeps them: replacing them with the menu would take away the thing it was opened for |

Two consequences worth stating outright:

- **Back replays, it does not re-run.** `history` holds past `NavState`s with
  the `lastView` each was on, so going back re-sends that screen and no flow
  renders a step it is not on. `bare()` strips stale decoration first.
- **Free text with no Redis state is not a fresh start.** The conversation
  expired (`BOT_NAV_TTL_SEC`) or a deploy dropped it, and answering with the
  guest menu as if the user had said nothing is the most disorienting thing
  this bot can do — say `bot.common.expired`.

`bot.progress.*` is one key per flow, never one key with the flow name
interpolated: a template cannot hold another template.

## Which language a chat is spoken to in

`from.language_code` is the language that user's *phone app* is set to — a
hint, not a statement about the product. A reseller selling in Iran to a
customer whose Telegram is English had no way to be understood, and the
customer had no way to ask. The order (ADR-0016):

1. **what the user chose** — `bot:lang:<platform>:<chatId>`, 180-day idle TTL,
   outside both the session and the navigation state: a preference that expires
   with the conversation that set it is one the user re-sets every time;
2. **`BOT_DEFAULT_LANGUAGE`** — optional, and set only when the bot speaks
   something other than the rest of the deployment;
3. **`DEFAULT_LANGUAGE`** — always set, so in practice this is the step that
   answers a first-time chat;
4. **the messenger's hint**, reached only when neither configured default is a
   language `locale-service` serves.

A configured language locale-service does not serve is skipped with a warning
and the next step answers — a misconfiguration, never a dead end.

`ChatLanguage.resolve` decides this once per update, in `BotDispatcher.handle`,
before anything reads `ctx.lang`. The chooser names each language in **its own**
words — someone who cannot read the current language must still find the way
out — and a result may carry `lang`, so the confirmation is written in the
language just chosen, not the one being left.

`auth-api` answers with the same order minus step 1 — `BotLinkService`'s
`fallbackLang()`, for a chat it holds no pending link for. The `/lang` choice
lives in this service's Redis and auth-service cannot read it; when there *is* a
pending link, `link.lang` outranks all of this anyway.

Not per-tenant yet: both vars are deployment-level because `tenant` is
schema-only. `F-317` moves them to a tenant row; the order does not change.

## Commands, and how a user finds them

`/start`, `/menu`, `/help`, `/cancel`, `/logout`, `/lang`. Every one of them is also a
button, because a command a user has to already know about is a command that
does not exist — and `BotWebhookRegistrar` publishes the list through
`setMyCommands` in each language, so the messenger's own command menu carries
them too.

`/help` mid-conversation prints above the question the user was on and keeps
their state. A help screen that ends the conversation punishes curiosity.
