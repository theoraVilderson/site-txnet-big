---
id: adr-0160
status: accepted
updated: 2026-10-23
---

# ADR 0160 — A RADIUS panel's users are imported in place, and moved only on request

- **Status:** accepted (built by F-1601-a … F-1601-d, F-1602, F-027-ay)
- **Date:** 2026-10-23
- **Decision:** the user's (2026-10-23)
- **Affects units:** network, entitlement, panel-web
- **Extends:** `entitlement/contract.import.md` (F-202's mapping),
  F-027-ag (User Manager as a push panel).

## Context

The migration page imports only Xray families (F-201). It maps each source
inbound to a product and recreates every client on a target panel, which
gives the client a new link. MikroTik User Manager and IBSng have no
inbounds. Their users are RADIUS accounts that a router or a NAS dials in
with. Recreating such an account elsewhere means a new username, password
and profile, and the end user has to change their own settings. C-17 says
the end user does nothing. The user asked for both cases (2026-10-23): when
nothing needs to move, use what the source already has; when users must go
to another panel, move them and rebuild their logins.

## Decision

1. **In place is the default.** The source router or server is (or becomes,
   in the run) a registered push panel. Each of its users becomes a Grant
   whose config *is* that same account. No new login is made, and nothing
   on the end user's side changes.
2. **Passwords are never read or copied.** The snapshot reads users,
   profiles, limits, used bytes, expiry and the disabled flag. Only the
   panel keeps the secret.
3. **A profile maps to a product**, where an Xray import maps an inbound. The
   idempotency key stays family, address and remote id (`contract.import.md`).
   The panel's own credit is switched off and the quota is written by us,
   as for every push panel (F-027-ag).
4. **A move happens only when someone asks.** The existing bulk move
   (F-311-ad/ae) takes a push panel as its source and any panel as its
   target. The new config gets a fresh login, and the user is told the new
   link or login. No import moves anyone by itself.
5. **IBSng follows the same shape (F-1602) once its driver exists.** IBSng has
   no API documentation, so the driver (F-027-ay) is built from the latest
   open-source IBSng code. Its wire shapes are checked against a dev Docker
   install of that same code, which is the real install ADR-0074's drivers
   are proved on. When a field install becomes reachable, it runs the same
   conformance suite. A difference is fixed in the one driver, never forked
   into a second.

## Decided while building it (user, 2026-10-23, F-1601-b)

6. **An in-place Grant stays on its router.** It is issued with no panel
   group, so no group places more configs for it; a move (decision 4) is
   what puts it anywhere else.
7. **A rollback hands the user back.** Our chain comes off, the user's own
   profile goes back on, and the user is never deleted. User Manager counts
   a profile's validity from its assignment, so that profile starts again.
8. **A normal end deletes**, as for every config of ours: a purge after the
   suspension window, or an admin's delete.
9. **Adoption waits for a real router** (F-1601-e). Whether User Manager
   checks `transfer-limit` against the user's lifetime total or against its
   profile decides the first ceiling written at adoption. The two answers
   err in opposite directions, by the user's pre-import usage, so it is
   proved on a RouterOS CHR in `dev-docker` before F-1601-b2 is built.

## Consequences

- Positive: a reseller with 3,000 RADIUS users switches billing to TXNet
  without one customer touching a device.
- Negative / accepted cost: an in-place import keeps the old router in
  service. Retiring it is the explicit move, user by user or panel by panel.
- What this forecloses: an import that silently recreates RADIUS accounts on
  another panel.

## Alternatives rejected

- **Always move to a target panel, as Xray imports do.** Every end user would
  have to reconfigure, which is the fear F-201's section exists to remove.
- **Copy passwords out so the move can keep them.** That makes the platform
  hold every RADIUS secret in the clear, for a move nobody asked for.

## Revisit trigger

A RADIUS family whose accounts cannot be adopted without rewriting them.
