---
id: adr-0011
status: accepted
updated: 2026-09-06
---

# ADR 0011 — `bot-service` is its own deployable, and it reaches auth-api with a service credential

- **Status:** accepted
- **Date:** 2026-09-06
- **Affects units:** bot-app, messenger, auth-api, identity, redis-keyspace

## Context

ADR-0009 decided *what* the bot is: two units, no business rules, one flow layer
over two renderers. It did not say where that code runs, and it left three
questions that only become real when someone builds `F-303` (register and log in
inside the bot):

1. **Where the flows live.** ADR-0009 explicitly rejected "keep growing it inside
   `auth-service`", but the only bot code that exists today — the `F-0203` link
   webhook — is inside `auth-service`, and a bot token holds exactly **one**
   webhook URL. Whoever owns that URL owns every update, so this cannot be split
   by accident: it has to be decided.
2. **The captcha.** `F-0201` requires an `X-Captcha-Token` on `register`,
   `login/password`, `login/otp/request` and `password/forgot`. It is a slider in
   a browser. A chat cannot produce one, so either the bot is exempt or the bot
   cannot log anyone in.
3. **What "signed in" means in a chat.** There is no cookie. A returning user
   must not re-run OTP on every message, and a chat id must still not be an
   authentication (`bot-app/contract.md`).

All three were put to the owner on 2026-09-06 and answered.

## Decision

We will run the bot as a **separate Nx application, `bot-service`**, owning the
inbound webhook (`POST /api/bot/:platform/webhook/:secret`) and calling
`auth-api` over HTTP exactly as `panel-web` does. `platform/messenger` ships as
an Nx **library** (`@txnet-backend/messenger`), not as part of that app, because
`identity`'s OTP senders and `bot-app`'s renderer are two consumers of one driver
— the §1 placement test for a `platform/` unit.

`identity` keeps every rule it has. The contact-ownership check behind invariant
#12 does **not** move and is not duplicated: `bot-service` forwards the two
link-relevant updates to two new service-only routes
(`POST /auth/bots/link/resolve`, `POST /auth/bots/link/contact`) and renders
whatever outcome they return.

Bot-originated calls carry a **service credential** (`X-Service-Token`, constant
-time compared against `SERVICE_AUTH_TOKEN`). A valid token waives the captcha
guard and *replaces* the per-IP rate-limit bucket with a per-chat and per-phone
one. It waives nothing else. Without the token the routes behave exactly as they
do today.

A successful bot login stores the ordinary `auth-api` refresh token in Redis at
`bot:session:<platform>:<chatId>`, with a 30-day idle TTL, dropped by `/logout`
and by any password reset. That entry — not the chat id — is what makes a chat
signed in.

## Consequences

- **Positive:** `auth-service` stops growing a second product inside itself, and
  a bot outage is a bot outage. One flow layer serves both messengers, and
  because every decision is an `auth-api` call, the bot and the panel cannot
  disagree. The captcha exemption is one guard with one credential, auditable in
  one place, instead of a hole in each route.
- **Negative / accepted cost:** a new deployable (compose, Traefik, env), a
  network hop on every step of a chat conversation, and a shared secret that must
  be rotated like any other credential. The webhook moves, so
  `POST /auth/bots/:platform/webhook/:secret` is deprecated for one release
  rather than deleted (§8). A leaked `SERVICE_AUTH_TOKEN` is a captcha bypass —
  the rate limits, not the captcha, are then the only thing between an attacker
  and OTP flooding, which is why the per-chat/per-phone buckets are part of this
  decision and not an implementation detail.
- **What this forecloses:** bot flows importing `identity`'s services directly;
  a second contact-verification implementation; treating a chat id as proof of
  identity; a per-platform bot codebase.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Bot flows as modules inside `auth-service` | the alternative ADR-0009 already rejected; `auth-service` becomes the whole product and the auth boundary stops meaning anything |
| A captcha challenge rendered as a chat step | a tap is not a proof-of-humanity, so it buys the shape of the control without its substance, and it costs every user an extra step on every login |
| Force the Mini App for the captcha | breaks the chat-first rule (ADR-0009); excludes exactly the user §10.4 exists for |
| Auto-login any contact-verified chat, no OTP | makes the chat id an authentication, which `bot-app/contract.md` forbids; one hijacked messenger account then owns the panel account |
| Short bot sessions, OTP on every visit | a reseller opens the bot several times a day; the cost lands on the user this feature was built for |

## Revisit trigger

Either of:

- The messengers gain a first-party proof-of-humanity signal we can verify
  server-side — the captcha exemption then stops being a bare exemption.
- `bot-service` needs a rule of its own that no domain will expose. That is a
  missing contract, and if it keeps happening the unit split, not the deployable,
  is what is wrong.
