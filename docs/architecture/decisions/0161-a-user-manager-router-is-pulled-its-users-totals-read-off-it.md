---
id: adr-0161
status: accepted
updated: 2026-10-23
---

# ADR 0161 — A User Manager router is pulled: its users' totals are read off it

- **Status:** accepted (built by F-027-ag-b; F-027-du-b builds on it)
- **Date:** 2026-10-23
- **Decision:** the user's (2026-10-23)
- **Affects units:** network, panel-web
- **Amends:** F-027-ag (User Manager as a push panel); ADR-0160 decision 1
  ("a registered push panel" reads "a registered panel").

## Context

F-027-ag declared User Manager `push` / `session`: the NAS was to send
accounting to our receiver (`RADIUS_ACCT_ADDR`), and the router's REST API
would carry only the ceiling. A real RouterOS 7.24 CHR (F-1601-e) showed
that a NAS sends a session's accounting only to the RADIUS server that logged
the user in. On a User Manager deployment that server is User Manager. A
second `/radius` entry hears `Accounting-On` and nothing else
(`network/contract.usermanager.md` rule 11). So no byte of a User Manager
user ever reached us, and a metered Grant on such a router was never charged.

The user chose (2026-10-23) to read each user's lifetime total off the router
(`user/monitor`) as a `cumulative` counter, and then to re-declare the panel
as `pull`. A push declaration with no packets would ask the registrant for a
RADIUS secret and a NAS address that serve nothing. Every later reader of
`transport = 'push'` (the receiver's allowlist, the address check, IBSng)
would also have to remember an exception.

## Decision

1. **User Manager is `pull` / `cumulative`.** `GetUsage` is each user's
   lifetime total. It goes through the pull turn as any family's reading
   does: normaliser, deltas, reset detection, the plausibility cap, the
   anchor. The registration form asks for no RADIUS secret and no NAS IP.
2. **A read is two requests, whatever the number of users**: the ids, then
   one `monitor` over them. The second pays the budget as a page does
   (ADR-0081). The conformance scenarios that count to the request hold a
   family to its declared fixed cost (`conformance.ReadCost`), never to one
   request per client.
3. **Existing User Manager panels are re-declared** by migration
   (`a_user_manager_router_is_read_not_heard`). The RADIUS secret reference
   is cleared, and the first pull read adopts the router's figure, so bytes
   from before are never billed.
4. **`push` stays** for a family whose NAS really does send us accounting.
   The push turn's read of router totals (F-027-du's rebase) is removed: no
   push family keeps one. `sessionCounterBytes` loses its last reader and is
   dropped by its contract step (F-027-ag-c, C-39).

## Consequences

- `transfer-limit` counts from the profile link, not the user's life (rule
  9), so the ceiling needs the link's origin: F-027-du-b.
- A User Manager panel now carries an anchor user, as every pulled panel
  does (ADR-0130). It is disabled and serves no login.
