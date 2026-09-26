---
id: adr-0090
status: active
updated: 2026-09-26
---

# ADR 0090 — a panel is registered once, and configured per group

- **Status:** accepted
- **Date:** 2026-09-26
- **Affects units:** billing (systems routes, group fulfilment), network (connection test, collector), panel-web (systems page)
- **Decision row:** D-48 (the agent's recommendation, accepted by the user)

## Context
Nothing stops the same panel being registered twice: `network.panel` has no
unique address, and a second row under another domain is indistinguishable.
Two rows over one panel each read every client on it (`ListClients` is
panel-wide), so each reports the other's clients as orphans and their usage as
unattributed, spends its own request budget against one server and counts its
own `maxClients`. Once `orphanPolicy = delete_remote` acts, each would delete
the other's clients.

The only reason to register a panel twice was to sell different inbounds of
it through different groups: the sold inbounds (`panel_inbound.sold`) are the
panel's, so every group holding a panel sells the same ones. A large server
running several panels in Docker is legitimate and must stay allowed — the
identity is the panel, not the host.

## Decision
We will identify a panel by what the panel itself answers, not by its address,
and move every *selling* choice from the panel to its group membership.

1. **Registered once.** Registration and every address edit are refused when
   the normalised `apiBaseUrl` (lower-case, explicit default port, no trailing
   `/`, path kept) is already registered. The connection test then refuses a
   panel whose client list holds a `claimTag` of another panel's config, and —
   for a panel with no clients whose inbound set (remote id, port, protocol) or
   resolved IP matches a registered one — runs a **canary**: a disabled client
   with a random tag is created through the registered panel, looked for on the
   new one, and deleted either way. Seen = the same panel = refused, naming the
   existing one. A collector pass that finds another panel's `claimTag` stops
   the panel and raises an alarm (an address re-pointed after registration).
2. **Three-layer settings.** A selling setting resolves group membership ->
   panel -> platform default, and always resolves: every layer below the member
   has a value. Selling settings: inbounds, `inboundPlacement`, `maxClients`,
   `priority`, `weight`. Server facts stay panel-only and are never overridden
   per group: addresses, credentials, `maxRequestsPerMinute`, `maxLineRateBps`.
   A read answers each effective value with the layer it came from.
3. **An inbound is the default pool's or one group's.** An inbound assigned to
   a membership leaves the panel's default pool; a unique index on
   `(panelId, inboundRemoteId)` over assignments holds that no two groups share
   it, under concurrency. A membership with no assignment sells the default
   pool, which is shared on purpose. Assigning an inbound with live configs in
   another group is refused with their count. Today's state is exactly "every
   group sells the default pool", so the migration moves no data and every
   placed config stays where it is.

## Consequences
- Positive: one server can run many panels, each registered once and read once;
  one panel serves any number of groups with disjoint inbounds; no setting is
  ever unanswered.
- Negative / accepted cost: the canary writes (and removes) one disabled client
  on a registered panel, only when a new panel is suspect.
- What this forecloses: registering a panel twice for any reason, and a group
  overriding a server fact.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| Unique `ipAddress` / host | refuses several Docker panels on one server |
| Warn on a suspect panel, admin approves | a new domain over an empty panel passes unnoticed |
| Hold a suspect panel `pending` with no canary | kept as the fallback for a family that cannot create a disabled client |
| A host entity with shared caps | not needed once a panel is registered once; revisit if host capacity is |

## Revisit trigger
A panel family that cannot create a disabled client or list clients, or a
demand to cap a whole host across its panels.
