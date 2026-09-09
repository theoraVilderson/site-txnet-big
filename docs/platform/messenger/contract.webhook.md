---
id: messenger
layer: platform
status: active
version: 4
updated: 2026-09-09
---

# messenger — contract: webhook addressing

A topic file of [contract.md](contract.md) (§10 — that file was at 259 lines).
It covers one question: where a bot's updates arrive, and what it takes to move
that address.

## Webhook addressing

**One unguessable path per bot** (user decision, 2026-09-05; ADR-0009). This is
what `automation.BotIntegration.webhookPath @unique` already models, and the
live `F-0203` route `POST /auth/bots/:platform/webhook/:secret` is already
per-secret — the same shape, so it converges rather than breaking (§8).

Why per bot and not one shared door: a shared endpoint is one failure point for
every reseller at once, and a token or ban problem on one brand's bot becomes an
outage on all of them. Per path, the blast radius is one tenant.

Consequences this unit must honour, all of them live since F-066-i:

- The path **is** the credential lookup. Resolving it yields the tenant and the
  platform; nothing about the sender is trusted before that, and in particular
  **the tenant is never read from the message body** — a body is written by
  whoever sent the update.
- An unknown path answers **404**, never a hint. A path is unguessable or it is
  not a boundary.
- Handling is best-effort and answers **200** once the path *and* the secret are
  known good, so the platform never redelivers.
- Rotating a bot token rotates the path with it, so a leaked path dies too.
  Rotation is live since `F-066-j` — see below.

### The secret token, verified on every request (`F-321`)

The `X-Telegram-Bot-Api-Secret-Token` header is checked on **every** Telegram
request — a missing header there is a forged request, because Telegram echoes
back whatever `setWebhook` registered. Bale does not send the field, so on that
platform a missing header is allowed and the 32-byte path is the whole
credential; a header that *is* present is verified on both, so a wrong one is
never waved through.

Verification is a fingerprint comparison, never a decryption: the value is not
needed, only the answer. A superseded version still inside its rotation grace
window verifies, which is what keeps an update signed seconds before a rotation
from being dropped (ADR-0026 decision 4).

### The platform registers on the tenant's behalf (`F-321`)

A reseller pastes a token into the panel and is done: `bot-service`'s
`BotWebhookRegistrar` asks `automation` for every registrable integration on
boot and points each one at
`<public base>/api/bots/<platform>/<webhookPath>`. The outcome is written back
to the row — `status` and `lastErrorAt` — because "the bot stopped answering"
has to be answerable from the panel rather than from a service log. `disabled`
rows are skipped, so a tenant that switched its bot off does not get it
silently re-registered; `error` rows are retried, since an error is the state a
registration failed *into*.

Registration stays best-effort and never fails boot, and one tenant's failure is
one tenant's — which is what per-integration handling buys over the old
per-platform loop.

### Rotating a path retires it first, and registers second (`F-322`)

A rotation writes the new `webhookPath` **before** it tells the platform about
it. The write *is* the retirement: `byWebhookPath` is a lookup on a unique
column with nothing cached in front of it in either process, so the moment the
row commits, the previous path answers the same bare 404 an unknown path always
did. Nothing waits for a boot, a cache expiry or an upstream round trip — which
is what catalog 10.2 means by *immediately*.

The order is the guarantee, and it is chosen against the obvious alternative. A
rotation exists to end an address, usually because that address leaked; making
it only as fast as the slowest Bot API call would mean a burned path stays
answerable for as long as Telegram is slow. So the window between the two steps
is one in which the bot is **unreachable**, never one in which it is reachable
at an address someone else knows.

What that costs is stated rather than hidden: a `setWebhook` that fails leaves
the row `pending` with the new path, the platform still delivering to a door
nobody answers, and the caller told `registered: false`. `pending` is
registrable, so `BotWebhookRegistrar` picks the row up on its next boot.

The webhook secret is **not** rotated with the path. It is a second credential
with a rotation of its own (ADR-0026), and re-registering with the value
in-flight updates are already signed with is what keeps an update sent moments
before the rotation from failing the header check.

The URL is built by this unit — `webhookUrl` / `resolveWebhookBase` in
`webhook-address.ts` — because two processes now build it: `bot-service` on
boot, and `auth-service` when it rotates. Built separately they would
eventually be built differently, and the symptom is a bot that re-registers
itself away from the running service on every restart. ADR-0011 is untouched by
this: the URL a rotation registers still names `bot-service`'s own door.
