---
id: network
layer: domain
status: active
version: 1
updated: 2026-10-15
---

# The address a panel is held to (F-027-ez, ADR-0130 decision 4)

A topic file of `contract.md` (§10). What governs
`network-service/internal/collect/address.go`, the pin in
`internal/egress` (`Pin`, `PinnedClient`) and the registrar's one lookup
(`register.Registrar.pinFor`). The *why* is **ADR-0130**: a panel's login was
sent to whatever its domain resolved to that minute, and TLS does not help —
whoever holds the domain can get a certificate for it.

## The rules

1. **A name is resolved once per test and once per turn, and only that
   answer is dialed.** The driver of a panel whose `apiBaseUrl` host is a name
   gets a client of its own (`egress.PinnedClient`) that dials the pin's
   addresses at the url's port — the name stays the `Host` header and the TLS
   server name. There is no second lookup between the check and the connect,
   so DNS rebinding cannot pass it. The egress guard (`contract.registration.md`
   "The address is dialed through the guard") still checks every address dialed.
2. **An empty pin dials nothing.** A driver call outside a checked turn —
   a new pin, or one a move emptied — is refused `unavailable`, never sent.
3. **A host that is an address has no pin.** It is dialed as it is; billing's
   same-address refusal (F-027-cd) and the anchor guard it.
4. **The accepting test records what it dialed.** The registrar resolves the
   host once, opens the driver pinned to the answer, and the verdict writes it
   as `panel.knownAddresses` in the same guarded, announced statement
   (`contract.registration.md` rule 3); empty for a host that is an address. A
   name that does not resolve is no verdict: `pending`, fault `unavailable`.
   The duplicate check's same-IP suspicion reads the same answer, and a
   suspect's canary is dialed at the suspect's own known addresses.
5. **Every turn checks before anything is sent** (`Loop.locate`, before the
   anchor check and before a push panel's turn): the answers that are known are
   the pin. A lookup that fails is the panel unreachable, observed as a failed
   read is (`contract.panel-health.md`), never a move.
6. **No known address among the answers = no login.** The pin is emptied and a
   halting `address_moved` drift event is raised with `knownAddresses` (old)
   and `seenAddresses` (new), set together and on no other type (CHECK
   `panel_drift_event_addresses_are_a_move`). It stops convergence too
   (`DriftEventType.Converges`), and is not called again until acknowledged —
   acknowledging trusts the new addresses and sends the panel back to the
   connection test (F-027-fa).
7. **`panel.addressMayMove`** (default off) is the opt-out for a panel behind a
   CDN: dialed at whatever the turn's one lookup answers, never halted for a
   move; the anchor alone guards it, after the login (ADR-0130 consequences).
8. **A panel accepted before F-027-ez learns on its first turn**
   (`AddressBook.Learn`, written over an empty list only) and is dialed at that
   answer; a write that fails is logged and learned on the next turn.
