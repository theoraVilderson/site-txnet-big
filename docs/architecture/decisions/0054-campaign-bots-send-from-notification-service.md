---
id: adr-0054
status: accepted
updated: 2026-09-17
---

# ADR 0054 — Campaign messages are sent from `notification-service`, through `messenger`

- **Status:** accepted 2026-09-17 (row F-035-e)
- **Date:** 2026-09-17
- **Affects units:** notification, messenger, auth-api

## Context

D-10 put the Telegram/Bale drivers in `messenger` and the per-recipient state in
`notification`, but did not say which *process* holds a bot token while a
campaign is sent. `messenger` is a library; it sends from whichever app binds a
`BotIntegrationDirectory`. Two did: `auth-service` (schema and vault in reach)
and `bot-service` (over `internal/bot-integrations`, whose seam client lived in
`bot-service` and could not answer "this tenant's primary bot").

The user left the choice to the agent, asking for the one that would not have
to be undone later.

## Decision

`notification-service` binds `messenger` itself and sends. Its directory is the
seam client, moved from `bot-service` into `messenger`
(`auth-api-bot-integration.directory.ts`) and bound by each app under its own
name — the vault audit row names `notification-service:notification:CampaignDelivery`.
`auth-service` gains `POST internal/bot-integrations/primary`, and the token
route takes a `service` from a closed list. Delivery is a `worker-service` job
calling `internal/notifications/campaigns/deliver`, as the fan-out is.

## Consequences

- Positive: bulk traffic and its retries stay inside the deployable ADR-0052
  created so they could not slow another edge; state, claim and send are in one
  process, so an outcome is recorded in the transaction code that owns it, and
  a rate-limited queue (F-313) has one place to live.
- Positive: one seam client instead of a second copy; `bot-service`'s
  `primaryFor`, which always answered `null`, now answers.
- Negative / accepted cost: a third process may decrypt bot tokens — only
  through the audited seam, never from the vault directly.
- What this forecloses: nothing; moving the sender later is moving one service
  class that depends on the `BotClientRegistry` port alone.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| `bot-service` sends on an internal route | campaign bursts on the process that answers every webhook — the coupling ADR-0052 exists to avoid — and an HTTP hop per message between state and send |
| `auth-service` sends, as OTP delivery does | campaign traffic beside login, which ADR-0052 rejected for this unit |

## Revisit trigger

If per-bot rate limiting (F-313) needs a limiter shared with the OTP senders in
`auth-service`, move the limiter into `messenger`, not the sender.
