---
id: adr-0052
status: accepted
updated: 2026-09-17
---

# ADR 0052 — Notifications run in their own deployable, `notification-service`

- **Status:** accepted 2026-09-17 (row F-035-a)
- **Date:** 2026-09-17
- **Affects units:** notification

## Context

`notification` had tables (the `init` migration) and no runtime. Its rows are
read by the panel's dropdown (F-093-h), written by other units through a seam,
and — from F-035-c on — carry campaign authoring, a fan-out and delivery
adapters (D-10). Every earlier unit without a runtime was hosted in an existing
service: `audit` in `auth-service` and `billing-service`, `automation`'s writes
in `auth-service`. The user chose otherwise for this unit when F-035 was split.

## Decision

We will run `notification` as its own Nx application, `notification-service`,
built on `billing-service`'s request edge: behind `forward-auth` at
`/api/notifications`, the gate's identity required on every route but `health`
and `internal/*`, the app-role pool, the shared rate limiter and envelope.
Other units reach it over `internal/*` with `SERVICE_AUTH_TOKEN` (ADR-0011).
The fan-out job (F-035-d) still runs on `worker-service` (ADR-0027); this
service owns the rows and the HTTP surface, not the scheduling.

## Consequences

- Positive: a campaign surge or a slow adapter cannot take the auth or billing
  edge with it; the unit's `source:` is one tree.
- Negative / accepted cost: a sixth Nest deployable — another compose block,
  Traefik router, preflight exemption and `FRONTEND_ORIGIN`, and one more
  process to keep up. The request-edge files are copies of billing's (an app
  cannot import an app); a rule change there has to be made here too.
- What this forecloses: nothing structural; merging it into another service
  later is moving one module.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Host in `auth-service` (audit's precedent) | the user's choice on 2026-09-17: notifications grow campaigns and adapters that do not belong beside login |
| Host in `billing-service` | notifications are not a billing concern |

## Revisit trigger

If the request-edge copies drift from billing's in a way that causes a bug,
extract that edge into `shared-core` rather than keep a third copy.
