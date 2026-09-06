---
id: adr-0014
status: accepted
updated: 2026-09-06
---

# ADR 0014 — switching accounts in the bot moves the session, not the link

- **Status:** accepted
- **Date:** 2026-09-06
- **Affects units:** bot-app, identity, audit

## Context

`F-0205`…`F-0209` shipped account switching: one person's accounts form a
proved group, and moving between them costs no credential. The panel renders
it. The bot does not, and `F-0210` — "switching accounts inside the bot" — was
left `later` in the catalog with a note saying it needed an ADR reopening
identity invariant #12 and the `@@unique([platform, platformUserId])` behind
it.

That note assumed one reading of the feature. There are two, and they differ in
what "this chat is account A" means.

A chat is bound to an account twice over, not once:

- a **link** — the `LinkedBotAccount` row a contact card proved (invariant
  #12), which is what decides where an OTP for a phone number is delivered and,
  since ADR-0012, is itself the credential a one-tap sign-in trades;
- a **session** — the refresh token in `bot:session:<platform>:<chatId>`, the
  chat's equivalent of the panel's cookie.

The panel's switcher (`F-0209`) moves only the second of these. The browser has
no equivalent of the first, which is why the question never came up there and
why the catalog note read the bot case as necessarily being about the link.

Reopening invariant #12 is expensive and not obviously safe: it is the
constraint that stops a shared or recycled chat id from receiving another
account's code, and `telegram.sender.resolveChatId` resolves a phone to a chat
through exactly that uniqueness. Loosening it turns a lookup with one answer
into a lookup with several, on the OTP delivery path.

## Decision

**We will switch the session and leave the link alone.** The bot's switcher
calls the same `GET /auth/accounts` and `POST /auth/accounts/switch` the panel
calls, on behalf of the chat's own session, and writes the returned refresh
token over the chat's Redis entry. `LinkedBotAccount` is not written, not
duplicated and not relaxed: a chat stays linked to exactly one account, and
invariant #12 stands untouched.

The bot therefore has the same relationship to a switch that a browser does —
it holds one live session at a time, and switching replaces it — with one
difference the browser has no analogue for: the chat's *link* still names the
account it was linked to, so the fast path is anchored there.

## Consequences

- **Positive:** `F-0210` costs no migration, no change to OTP delivery and no
  weakening of the one constraint that keeps a code from reaching the wrong
  chat. It is a screen and two API calls the platform already exposes, and it
  is identical in behaviour to the panel, which is what ADR-0009 asks of every
  bot capability.
- **Positive:** `audit` keeps its whole trail. Every switch is still one
  `switchSession` transaction with `account_switched` on the outgoing row
  (audit invariant #7) — the bot is another caller, not another mechanism.
- **Accepted cost:** after `/logout`, or after the 30-day session TTL lapses,
  the chat's one-tap sign-in (ADR-0012) returns to the **linked** account, not
  the one the user last switched to. Reaching the other account again is one
  more tap: sign in, then switch. The user was shown this trade and chose it.
- **Accepted cost:** an OTP for the second account's phone still arrives in
  whatever chat *that* account is linked to — possibly none. Signing into it
  directly, rather than switching into it, is unchanged by this ADR.
- **What this forecloses:** nothing. A later ADR may still relax invariant #12;
  this decision sits underneath that one rather than in its way, because
  session switching would remain the mechanism even if the link became
  many-valued.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Relax `@@unique([platform, platformUserId])` so a chat may link to every member of its group | Buys one tap after a sign-out, at the price of a migration, a rewrite of `bots/session` (which member is *this* chat?) and a phone→chat lookup on the OTP path that stops having one answer. The cost is not in proportion to the gain |
| Keep a per-chat "acting as" pointer next to the link, and let `bots/session` sign into that | A second identity concept, owned by `bot-app`, that no other surface has and that would drift from the session it shadows. ADR-0009 exists to stop the bot inventing exactly this |
| Leave `F-0210` unbuilt | The capability is real and the panel has had it since `F-0209`. "Available on the web only" is the failure mode §10.4 exists to prevent — an Iranian reseller works from a phone |

## Revisit trigger

Reopen if users report the post-sign-out tap as a real cost — concretely, if a
chat's switch is followed by a sign-out and a switch back often enough to see
in `audit`'s trail — or if a capability arrives that genuinely needs a chat to
be more than one account at once, such as receiving each account's
notifications (`F-319`) in the same chat.
