---
id: adr-0017
status: accepted
updated: 2026-09-08
---

# ADR 0017 — the Mini App signs itself in with the signature the platform hands it

- **Status:** accepted
- **Date:** 2026-09-08
- **Affects units:** identity, auth-api, panel-web, bot-app, messenger

## Context

`F-310` puts `panel-web` inside Telegram and Bale as a Mini App. ADR-0009
already settled what it is: **the same PWA**, sharing a session — never a third
UI. What it did not settle is how the session gets there.

A webview is an ordinary browser with an empty cookie jar. So the panel's first
paint inside a messenger fails `ensureSession()`, and the honest reading of
that failure — "nobody is signed in here" — sends the user to a login screen
*inside the messenger they are already authenticated to*. That is the feature
failing at its only interesting moment: the messenger knows exactly who is
looking, and the panel starts by asking them to prove it again.

What the platform hands the page instead is `initData`: a query string signed
with the bot's own token (HMAC-SHA-256 over the sorted data-check-string,
secret = `HMAC("WebAppData", token)`). Both platforms use the identical scheme
(`docs/platform/messenger/contract.md`, verified 2026-09-05). It names the
messenger account — the same platform user id a private chat carries as its
`chat.id`, which is what `LinkedBotAccount.platformUserId` already holds.

## Decision

**A verified `initData` is the Mini App's presentation of the credential
ADR-0012 already defined.** It adds no new factor: what it proves is *which
messenger account is looking at the page*, and ADR-0012 decided what that is
worth. `auth-api` exposes `POST /auth/bots/webapp/session`, which verifies the
signature and then runs the identical rule as `POST /auth/bots/session` — the
link must be contact-verified, the account live and phone-verified, the role on
`BOT_SESSION_ROLES`.

Four consequences, and each is the part that would be got wrong by default:

1. **The route is public.** Every other route on that controller is
   service-only, because `bot-service` calls them. This one is called by a
   browser, which can keep no secret, and the signature *is* the
   authentication. Guarding it with `X-Service-Token` would mean shipping that
   token to every webview — which is the one way to actually lose it.
2. **The session is the browser's, not the chat's** (ADR-0015). The webview
   goes on to call `/auth/accounts` with its own `device_id` cookie like any
   other browser, so its session is minted under `device:<uuid>`. Minting it
   under `bot:<platform>:<chatId>` would show it a switch group that none of its
   own later calls could see, which reads as a group that silently emptied.
3. **The answer is shaped like a browser login**, not like the bot route:
   `{accessToken, expiresIn}` in `data`, the refresh half in the httpOnly
   cookie. The refresh token never reaches a script, and no part of `panel-web`
   past `lib/mini-app.ts` knows it is in a webview.
4. **A replay window, not a session length.** The signature is issued once, when
   the app opens, so acceptance is capped at one hour
   (`WEB_APP_INIT_DATA_MAX_AGE_SEC`) — long enough to open the app, read
   something and come back; short enough that a captured string is not a
   permanent key. The vendors suggest a day; a day is a session, and this is
   not one.

**A chat that has never shared its contact card is answered `needsContact` and
nothing else.** A Mini App cannot request one — that keyboard exists only in a
chat — so this surface cannot close the gap and must not pretend to. The
visitor gets the ordinary login screen, and the conversation, which already has
a screen for exactly this, is where the link is made.

## Consequences

- Opening the Mini App from the bot's menu lands a linked user in their own
  panel with no login step. An unlinked one lands on the login screen — the
  same screen the panel shows on the web, not a Mini-App-specific dead end.
- `messenger` gains the verification (`web-app-init-data.ts`) because it is the
  only unit holding a bot token, and the token stays inside it: callers hand
  over a string and are told who it names. `identity` keeps the rule about what
  that entitles someone to. The split is the same one invariant #12 already
  draws for contact cards.
- Chat-first (ADR-0009) is untouched. The Mini App is a row on the member menu
  — one more destination — and no capability moved into it. A `BotView` whose
  chat path is empty because the Mini App does it better is still a bug.
- The trade named in ADR-0012 is inherited whole, including its role
  allow-list: this route signs in `user` and refuses everyone else, so a
  privileged account opening the Mini App falls through to the ordinary login.
- One route more for the surface that can be probed anonymously. It is
  rate-limited per IP rather than per chat, because before verification the only
  chat id available is one the caller chose.

## Alternatives rejected

- **Trust `Telegram.WebApp.initDataUnsafe`.** The vendor named it. It is the
  same data with the signature dropped, which makes it a claim by whoever
  opened the page.
- **Have the Mini App ask `bot-service` to sign it in.** `bot-service` would
  have to be reachable from a browser and would be forwarding an identity claim
  it cannot verify without the rule that lives in `identity` — ADR-0009 and
  ADR-0011 both forbid it.
- **A one-time token minted in the chat and passed through the deep link.**
  Invents a second credential to carry a proof the platform already signs, and
  puts it in a URL — the place a credential is least survivable.
- **A Mini-App-only session type, short-lived and separate.** Two session models
  for one user, and every question about revocation would then have two answers.
  The session is the ordinary one or it is a new subsystem.
