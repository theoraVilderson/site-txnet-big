---
id: network
layer: domain
status: draft
version: 1
updated: 2026-10-06
---

# Panel health — a panel is blamed only for what it answered

A topic file of `contract.md`. It governs what `panel.panelState` says
about a panel and on what evidence: the failure's cause, its confirmation,
when it started and when it was last judged. It also governs how our own
outage is kept from reading as the panel's. The decision and its reasons are
ADR-0122. Read this before changing `driver.CauseOf`, `panelstate.Judge`,
`ConfirmAfter`, or anything that reads `panelState` as current.

The gate itself is unchanged: which kinds are asked again, the ban's clock
and its cool-off are [contract.budget.md](contract.budget.md) (F-027-v).

## The cause (F-027-ej)

Every failed turn has a `driver.Cause`, mirrored by `network.PanelFaultCause`
and stored as `panel.panelStateCause` while the panel is not healthy (CHECK
`panel_state_cause_needs_trouble`). `driver.CauseOf` derives it once for
every family, from the transport error or the status. A driver sets
`Fault.Cause` only where it knows better: a refused form login answered as a
`200` is `login_refused` even on the refusals that are still `unavailable`
(`LoginRefusals`).

| cause | read from | the owner's fix |
|---|---|---|
| `dns_failed` | a `*net.DNSError` | the domain's DNS record |
| `connection_refused` | `ECONNREFUSED` | the panel's port, or its service is stopped |
| `unreachable` | `EHOSTUNREACH`/`ENETUNREACH`, or a dial that never connected | the server is off, or a firewall drops us |
| `unresponsive` | our deadline on a connected panel (`FaultTimeout`) | the panel hangs or is overloaded |
| `tls_failed` | an x509 or TLS handshake error | the certificate |
| `not_found` | `404` | the panel's path changed (x-ui's secret base path) |
| `server_error` | `5xx` (not `501`/`504`) | the panel itself |
| `login_refused` | `401`, or a refused form login | a new login (rule 8 of panel-web's `contract.systems.md`) |
| `forbidden` | `403` outside the login | our address is refused |
| `rate_limited` | `429` | the request budget |
| `bad_answer` | anything else that answered | a family quirk, a panel version |

The first five are the **network layer**, where nothing on the far side spoke
(`Cause.NetworkLayer`). Only these can be our own outage. The rest are
answers and are always the panel's.

## Confirmed, not reactive

- A healthy panel moves to `down` (from `unavailable` or `timeout`) or to
  `degraded` (from `unsupported` or `protocol`) only on the **`ConfirmAfter`
  (3)th judged failure in a row**. Before that, nothing is written. The
  count is the tracker's alone, so a restart starts it again, which only
  delays a first alert.
- A panel already in trouble follows the next judged failure at once. A new
  cause is written, but `panelStateSince` is **not restarted**: it is when
  the trouble began, so a panel down for three days says three days.
- `throttled_or_blocked` keeps its immediate gate and alert (F-027-v),
  cause included.
- The first clean turn is `healthy`, with the cause cleared and
  `panelStateSince` set to that turn.
- A repeated timeout is now evidence. Once confirmed, it is `unresponsive`.
  A single one still changes nothing.

## Judged turns are stamped

Every turn that judged the panel stamps `panel.panelCheckedAt`
(`Writer.Checked`), and a clean one stamps `lastHealthyAt` as well. Neither
stamp ever moves backwards. A failure no driver classified, such as a failed
publish or a cursor write, is ours: it is neither judged nor stamped. A
reader tells a fresh state from a stale one by `panelCheckedAt`, never by
`panelState` alone.

## Not yet

Our own reach (egress probes, the mass-failure rule, freezing) and the
collector heartbeat are F-027-ek. The `network.panel.state_changed` event is
F-027-el: a type with no bound queue stalls the relay. What the page shows
is F-027-em.
