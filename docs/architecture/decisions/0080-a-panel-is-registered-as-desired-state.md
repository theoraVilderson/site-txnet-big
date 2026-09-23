---
id: adr-0080
status: active
updated: 2026-09-23
---

# ADR 0080 — a panel is registered as desired state, and a hold is released through the meter

- **Status:** accepted
- **Date:** 2026-09-23
- **Affects units:** network, billing, panel-web

## Context

ADR-0074 says a panel is accepted or refused by a **connection test at
registration**: `Driver.Capabilities` answers the sixteen questionnaire rows
and `Capabilities.Verdict` turns them into `reviewState`. That code lives in
`network-service`, which by ADR-0071 has no HTTP surface but `/health` — it
holds the cross-tenant role, so a route into it would be a route into every
tenant's network.

F-027-ad (the systems page) was written as one panel-web row that needs the
test, the read models behind the page and two write actions — acknowledging a
drift event and ending a hold. None of that is served, and nothing said how a
registration reaches the test, or what "release" does to a held byte.

## Decision

1. **Registration is desired state.** A route in `billing-service` writes the
   `panel` row with `reviewState = pending` and its credentials through the
   vault. `network-service` picks up pending panels on its own tick, runs the
   connection test, and writes `capabilities` and the verdict. The page reads
   the verdict back; nothing calls the Go service. This is F-027-z's pattern
   applied to panels.
2. **The systems page is the platform owner's**, but every route behind it is
   scoped by `tenantId` from the first line, so opening it to a reseller with
   a dedicated panel is a permission change rather than a rewrite. A reseller
   **registering** a panel stays closed: the collector would then dial an
   address a tenant chose (SSRF), which is its own decision
   (`network/open-questions.md`).
3. **A released hold goes through the ordinary meter.** It becomes a delta with
   a `deltaId` derived from the hold's id and is consumed like any other, so
   deduplication, the plausibility cap, the ceiling and block purchase all
   apply, and a second release is absorbed as "already applied". A write-off
   is never charged and records who wrote it off and why. There is still no
   `dropped` state.

## Consequences

- Positive: no new attack surface on the cross-tenant service; the Go side
  stays a loop that reads desired state and writes observations.
- Positive: one path writes consumption. A release cannot skip a rule the
  normal path holds.
- Negative / accepted cost: a verdict arrives on the next tick, not in the
  response to the click. The page shows `pending` until it does.
- Negative / accepted cost: F-027-ad becomes three rows — F-027-aq (the Go
  half of registration), F-027-ar (the routes), F-027-ad (the page).

## Alternatives rejected

| Option | Why rejected |
|---|---|
| An internal HTTP route on `network-service`, called by `billing-service` with a service token | the first route into the process that sees every tenant; each later need lands there too, and ADR-0071's boundary erodes one route at a time |
| Request/reply over RabbitMQ | no RPC-over-queue pattern exists here; timeouts and lost replies are new failure modes for a result that desired state delivers anyway |
| A release written straight into `consumedBytes` | a second path for consumption that skips deduplication and the ceiling — the downstream special case ADR-0074 forbids |
| Open the page to resellers now | registration by a reseller is an SSRF decision and `delete_remote` on a reseller's panel is still open; both would be answered implicitly |

## Revisit trigger

A connection test that has to answer interactively, such as an owner fixing
credentials in a loop and waiting several ticks for each try. Or a reseller
asking to register its own panel, which reopens decision 2.
