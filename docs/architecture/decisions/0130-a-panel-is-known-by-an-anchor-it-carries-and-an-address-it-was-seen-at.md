---
id: adr-0130
status: active
updated: 2026-10-15
---

# ADR 0130 — a panel is known by an anchor it carries and the address it was seen at

- **Status:** accepted (built 2026-10-15 — rows F-027-ew..F-027-fh, all done)
- **Date:** 2026-10-07
- **Affects units:** network (connection test, collector, convergence, RADIUS allowlist), billing (systems routes, placement), panel-web (systems page)
- **Decision row:** D-67 (the agent's recommendations, accepted by the user)
- **Extends:** [ADR-0090](0090-a-panel-is-registered-once-and-configured-per-group.md) decision 1. It does not replace it.

## Context
ADR-0090 recognises a server by **our clients on it**: a `claimTag` or `uuid`
of another panel's config is proof (`contract.drift.md` "the collector
guard"). That proof is missing exactly when a server holds none of our clients,
and the user walked through the cases on 2026-10-07:

- A panel's address is re-pointed (DNS, or a new database on the same IP) to a
  server we do not know, or to a reinstalled empty one. No orphan carries our
  tag, so `foreign_claim` never fires. Every config reads `missing` and is
  recreated there. The pass after, every recreated counter reads backward and
  raises `mass_reset`, which names a backup restore that never happened.
- A domain is re-pointed at a registered panel with no configs yet. The wrong
  panel is halted. The re-pointed one keeps converging onto a server that is
  not its own.
- Two registrations of one server, both `pending` at the same time, each pass
  the duplicate check, because the check compares only with accepted panels.
- The panel's login is sent to whatever the domain resolves to that minute.
  TLS does not help: whoever holds the domain can get a certificate for it.

Four bugs came out of the same walk and are fixed with it. A halted panel
still takes new buyers. A restore on a panel with fewer than five of our
clients is charged twice. Two push panels at one `ipAddress` drop each other
off the RADIUS allowlist, across tenants, with only a log line. A drift event
reaches nobody but the systems page.

## Decision
1. **Every pull panel carries an anchor.** The connection test (or the panel's
   first pass, for one accepted before this) creates a disabled client with a
   1-byte limit and no expiry: tag `anchor-<random>`, a fresh uuid. The tag
   and uuid are kept on the panel row and are unique. It uses the same create
   path as the canary, so a family that cannot make a canary cannot be
   accepted either. The anchor is never an orphan, never a seat, never billed
   and never converged.
2. **Every pass looks for the anchor before anything else.**
   - **It is there:** the pass goes on as today.
   - **Another panel's anchor is there:** `foreign_claim`, naming that panel,
     even if it has no configs.
   - **Neither is there:** a new halting event, `identity_lost`. Nothing is
     read, written or recreated.

   Acknowledging takes a choice. **`rebuilt`** means the same server was
   reinstalled: a new anchor is planted and every config is recreated.
   **`address_fixed`** means the address is right again: the next pass checks
   once more.
3. **Registration is serialised and judged by anchors.** One advisory lock is
   held over the duplicate check and the planting of the anchor, so two
   pending registrations of one server cannot both pass. A server carrying the
   anchor of another non-retired panel is refused, naming it. Configs left
   behind by another panel, with no anchor of theirs, are a warning, not a
   refusal.
4. **A domain address is pinned to the IPs it was accepted at.** The host is
   resolved once per pass and the driver dials the IP it checked. There is no
   second lookup, so a DNS rebinding cannot slip past the check.
   - **No known IP answers:** the login is not sent, and a halting
     `address_moved` event names the old IPs and the new ones. Acknowledging
     it trusts the new IPs and sends the panel back to the connection test.
   - **The opt-out:** `addressMayMove` (default off) exempts a panel behind a
     CDN. The anchor alone guards such a panel.
5. **Fixes found in the same walk:**
   - A halted panel takes no new buyer, and does not count toward
     `minHealthyPanels`.
   - A recreated client's cursor starts at zero, so it is not a reset.
   - `mass_reset` also fires when every cumulative counter read (at least 2)
     went backward in one pass. The 5-counter floor and the 20% threshold stay
     as they are.
   - A push panel's `ipAddress` is registered once.
   - A halting event is announced in the statement that raises it, its
     panel's owner gets a notice, and the systems page re-reads live (C-14).
6. **`orphanPolicy` acts only behind the anchor.** When `adopt` or
   `delete_remote` is built, it may act only in a pass whose anchor check
   passed. Otherwise a re-pointed address would delete or adopt a stranger's
   users.

## Consequences
- Positive: an empty, reinstalled or foreign server is told apart before any
  write. A stolen domain never receives the panel's login. The wrong panel is
  no longer the one halted. `mass_reset` means a restore again.
- Negative / accepted cost: one disabled client on every panel. A reseller who
  deletes it halts their own panel, and the event says why. A panel with
  `addressMayMove` on still sends its login on a move. The anchor check then
  happens after the login.
- What this forecloses: recreating configs on a server whose identity was not
  checked in the same pass.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| Raise `mass_missing` when most configs vanish | misses an empty panel, cannot tell a reinstall from another server, and would be rebuilt later |
| TLS certificate pinning | Let's Encrypt renewals change the key by default; the pin would flap every 60–90 days |
| Halt on any IP change, no opt-out | a panel behind a CDN would halt every few minutes |
| Lower the `mass_reset` floor below 5 | a three-client panel with one ordinary reset would halt; the user set 5 and 20% on 2026-09-23 |

## Revisit trigger
A family that cannot create a disabled client, a reseller base that mostly
fronts panels with a CDN, or `orphanPolicy` actions being built.
