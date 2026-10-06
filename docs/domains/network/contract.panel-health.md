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
publish or a cursor write, is ours: it is neither judged nor stamped. Nor is a
call **our own breaker stopped** (`driver.Reached`, `ErrCircuitOpen`): it never
reached the panel. Judged, it read as `unreachable` every other pass between
real dials, and each flip was a new cause told to the owner, once a minute
(dev, 2026-10-06). It is not counted toward the mass rule either. A
reader tells a fresh state from a stale one by `panelCheckedAt`, never by
`panelState` alone.

## Our reach is ruled on before a panel is blamed (F-027-ek)

`reach.Gate` wraps the tracker. An answer goes straight through. A
network-layer failure is **held until its pass ends**: a bulk pass is
bracketed by `BeginPass` (each panel's host) and `EndPass`, and a polled
turn's failure waits for the next pass. At `EndPass`, if anything was held:

| ruling (`collector_heartbeat.egress`) | when | held failures |
|---|---|---|
| `down` | no `NETWORK_EGRESS_PROBES` TCP probe connected | all frozen |
| `suspect` | ≥ 5 distinct **hosts** asked and ≥ 80% failed at the network layer, probes up | all frozen |
| `dns_down` | `NETWORK_EGRESS_DNS_PROBE` did not resolve | `dns_failed` frozen, the rest forwarded |
| `ok` | otherwise | forwarded, at the moment each was seen |

- **Frozen** means never forwarded: the panel keeps its state, cause and
  count, and `panelCheckedAt` is not stamped. Readers show it *on hold*,
  never *down*, and no owner is told. `NetworkCollectorEgressDown` is the
  operator's alert.
- **Mass is counted by host**, so six panels on one dead server are that
  server down. The panels are told; it is not our outage.
- **Probes are operator-set** (`host:port`, comma-separated, `none` for an
  empty list). Defaults: `1.1.1.1:443, 8.8.8.8:443, 9.9.9.9:443` and
  `cloudflare.com`. Pick them on the same side of any national border as the
  panels: a domestic server whose international link is cut must fail its
  probes exactly when it fails its panels. An empty list proves nothing and
  freezes nothing. Probes are dialled only on a pass that has a network
  failure, never per panel.

## The collector beats every pass

`EndPass` upserts `network.collector_heartbeat` for its instance
(`NETWORK_COLLECTOR_INSTANCE`, default the hostname): `passAt`, panels
judged and failed, and the ruling with `egressSince` (when it began, not
restarted while it holds). A pass with nothing to say still beats. Billing
reads the freshest row; older than `STALE_AFTER_SECONDS` (300) means the
collector is **stopped**, and every panel is `unknown` whatever it stores.
A dead instance's row is never deleted, it is just not the freshest.
`network.collector_watchdog()` serves the exporter (`network_collector`):
`NetworkCollectorSilent` (> 300s for 2m), `NetworkCollectorEgressDown`.

On dev the binary runs under `air` with `rerun = true`. A binary that exits,
typically the boot check refusing a schema whose migration has not landed,
is run again rather than leaving the collector dead until the next file
change (the incident ADR-0122 records).

A panel the vault cannot open is not offered to the pass at all
(`PostgresSource`), so it is never judged: its `panelCheckedAt` ages while
the heartbeat is fresh, and that is how a reader shows "not being checked".

## A confirmed change is announced (F-027-el)

Every state write (`Verdict.Changed`: a new state or a new cause) inserts
`network.panel.state_changed` in **the same statement**
(`panelstate.StateChangedEvent`). Its payload is the panel, its name, the
owner tenant (the platform_owner's for a platform panel) and `ownerUserId`,
`panelState`, `previousState`, `cause` and `since`. A turn frozen as our own
outage writes nothing, so it announces nothing. automation's
`PanelTestedConsumer` pushes it on `tenant:` and tells the owner by cause
(automation `contract.outbox.md`). Verified on dev 2026-10-06: the owner's
inbox read «پنل در دسترس نیست: اتصال رد شد» three passes after the port
closed.

## Not yet

What the page shows is F-027-em.
