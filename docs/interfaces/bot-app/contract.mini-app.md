---
id: bot-app
layer: interface
status: active
version: 13
updated: 2026-09-21
---

# bot-app — the Mini App

This unit's share of `F-310`. Split out of [contract.md](contract.md) at 250
lines (§10): one self-contained row with one reader, and every other section of
the contract is read without it. The panel's half is
[panel-web/contract.mini-app.md](../panel-web/contract.mini-app.md).

One row on the member menu, `kind: 'web_app'`, pointing at `PANEL_BASE_URL`
with `?ma=<platform>` on it (`views.ts` `MINI_APP_PARAM`).
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
- **The URL names the messenger** (`?ma=telegram` / `?ma=bale`, added
  2026-09-10). Neither platform injects its `WebApp` global on its own — each
  serves its own script — and the page cannot work out which one to load from
  inside a webview. So this unit, which knows, says. The marker is a **hint,
  not a credential**: the server verifies the signature itself, so a forged
  marker picks the wrong script and buys nothing. Any query already on
  `PANEL_BASE_URL` is preserved. Without it the panel loaded no SDK, found no
  signature, and sent every Mini App visitor to the login screen — which is
  what `F-310` looked like from 2026-09-08 until this was fixed.

The page then signs *itself* in: it loads that platform's WebApp script, the
platform hands it a signed `initData`,
`panel-web` presents that to `POST /auth/bots/webapp/session`, and the session
that comes back is the ordinary one (ADR-0017). This unit is not in that path
at all — it hands over a URL, and the credential is the platform's signature,
never anything this bot passes along. Degradation is the renderer's
(`messenger`): a platform without the WebApp surface gets the same URL as a
plain link.

## The second place it is offered: a throttled sign-in

`BOT_UNPROVEN` caps a chat's unproven traffic across the captcha-gated routes, and since
ADR-0070 the budget is the **chat's own** — so the chat this refusal stops is the one that
spent it, and no customer is ever refused for somebody else's traffic. It is still offered
the Mini App rather than a bare "try later" (`flows/throttle.ts`): a chat that has honestly
run out of attempts has somewhere better to go than a wait.

The offer works because of what the Mini App *is*, not as a consolation: it is a browser,
so it can carry the slide a chat cannot, and it signs itself in from the platform's own
signature (ADR-0017) rather than through any gated route. The door the refusal closes is
the one door the offer does not use.

**The refusal is recognised by `error.reason === 'botTrafficThrottled'` and by nothing
else** (ADR-0043). `msg` arrives already translated, so matching on it breaks in the next
language; the HTTP status is not read at all, which is `AuthApiClient`'s own rule
(ADR-0009). A refusal naming no reason stays an ordinary refusal and renders as its `msg` —
which is every refusal that existed before this.

The screen carries its own sentence (`bot.common.throttled`), not `auth.temporarilyLocked`:
that key is written for a screen with nowhere to go, and this one has a button under it. A
deployment with no `PANEL_BASE_URL` gets the sentence with no button, the same rule as the
menu row above.

Six call sites reach a gated route, and four of them — login by code, forgot, register and
adding an account by code — send through `OtpStep.request`, so the branch lives there once
rather than four times, one of which would have been forgotten. The two password proofs
(`login`, `accounts/add`) branch at their own call sites.
