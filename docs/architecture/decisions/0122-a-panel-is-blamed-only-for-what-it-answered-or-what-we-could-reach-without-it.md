---
id: adr-0122
status: accepted
updated: 2026-10-06
---

# ADR 0122 — a panel is blamed only for what it answered, or for what we could reach without it

- **Status:** accepted
- **Date:** 2026-10-06
- **Affects units:** network, billing, panel-web, automation, notification

## Context

On 2026-10-06 the user found a panel shown as healthy for three days while
it was unreachable. Its owner had changed the password, and later the port.
The dev collector's binary had exited under `air` on 2026-10-03, so nothing
wrote `panel.panelState`, and the last value, `healthy`, stood. The
investigation found four gaps:

1. **A state is written only by a running collector.** Nothing on the page
   could tell a fresh `healthy` from a three-day-old one.
2. **A cause was collapsed into a kind.** `driver.FaultUnavailable` covers a
   name that no longer resolves, a closed port, a host that does not answer
   and a `502`. These are four different things to tell the owner.
3. **Our outage reads as theirs.** The watchdog (F-027-w, ADR-0078) ages
   every panel separately. A dead collector, or an egress cut on our server,
   ages all of them at once and blames each one.
4. **Nobody was told.** `panelstate.Alerter` exists and is wired to nothing.

The user's requirement (2026-10-06): the principled fix, one that holds at
many tenants and panels, that names *why* a panel is unreachable (a changed
DNS record, a server problem, a changed port, a changed login), and that
**never blames a reseller's panel when the fault is our server's**.

## Decision

We will judge a panel only on evidence that implicates it, and report the
collector's own health beside the panels so that silence is never shown as
health.

1. **A cause, not only a kind.** Every `driver.Fault` carries a `Cause`
   (`PanelFaultCause`, the closed set below). It is classified once, in
   `driver`, from the transport error or the HTTP answer. A family's quirk
   overrides it in its own driver, as `FaultForStatus` already allows.
   `panel` stores it as `panelStateCause`, beside `panelStateSince` and
   `panelCheckedAt`. `lastHealthyAt` is written on every clean turn.

   | cause | evidence | layer |
   |---|---|---|
   | `dns_failed` | the name does not resolve | network |
   | `connection_refused` | the host answered with a reset on that port | network |
   | `unreachable` | no route, or the dial timed out | network |
   | `unresponsive` | connected, then our deadline passed on N turns running | network |
   | `tls_failed` | the handshake or the certificate failed | network |
   | `not_found` | `404` on the login or the API path (the path changed) | answer |
   | `server_error` | `5xx` | answer |
   | `login_refused` | the panel refused the stored login | answer |
   | `forbidden` | `403` outside the login (our address refused) | answer |
   | `rate_limited` | `429` | answer |
   | `bad_answer` | an answer we cannot read | answer |

2. **An *answer* layer cause is always the panel's.** The panel spoke, so
   nothing on our side can produce it.
3. **A *network* layer cause is the panel's only once our own reach is
   proven** in the same pass:
   - **Egress probes.** When a pass has any network layer failure, the
     collector dials `NETWORK_EGRESS_PROBES` (TCP `host:port`, operator-set,
     domestic or foreign to match where the panels are) and resolves
     `NETWORK_EGRESS_DNS_PROBE`. If every TCP probe fails, our egress is
     down. If the DNS probe fails, our resolver is down and every
     `dns_failed` that pass is ours.
   - **Mass failure.** If at least 5 distinct hosts were asked and at least
     80% failed at the network layer in one pass, the outage is treated as
     ours (`suspect`), even with the probes up. Two hundred providers failing
     in the same minute is not two hundred coincidences.
   - An outage judged ours **freezes** the panels it touched. Their state,
     cause and confirmation count are not advanced, and `panelCheckedAt` is
     not stamped. The page shows *on hold*, never *down*.
4. **Confirmed, not reactive.** A panel leaves `healthy` for `down` or
   `degraded` only after **3 consecutive judged failures** (about three
   minutes at `collect.DefaultInterval`). The first clean turn brings it back.
   `throttled_or_blocked` keeps F-027-v's immediate gate: we stop asking at
   once, because retrying through a ban earns the ban.
5. **The collector reports on itself.** Every completed pass upserts its row
   in `network.collector_heartbeat`: instance, `passAt`, panels asked and
   failed, and `egress` (`ok` / `down` / `suspect`) with `egressSince`.
   Billing reads the freshest row. When it is older than
   `STALE_AFTER_SECONDS` (300, the existing watchdog figure), the collector
   is `stopped`, and every panel is answered `unknown`, not its stored state.
6. **A confirmed transition is announced once.** It is written as
   `network.panel.state_changed` in the same statement as the state
   (ADR-0021's outbox, like `network.panel.tested`). Automation pushes it on
   the owner's `tenant:` channel, where the systems page re-reads it
   (ADR-0121), and tells the owner in the inbox and bot: once on the way
   down, with the cause, and once on recovery. Frozen turns announce
   nothing.

## Consequences

- Positive: an owner is told what to fix (a DNS record, a port, a login)
  instead of only "down". A collector crash or an egress cut reads as ours
  on every page and alerts no reseller. At scale, mass failure stays one
  operator problem, not a thousand tenant alerts.
- Negative / accepted cost: about three minutes before a real outage is
  reported, and a real panel outage that coincides with ours is shown as
  *on hold* until our side is back. Both are the honest answer. The probes
  are a few dials per failing pass, never per panel.
- What this forecloses: reading `panelState` alone as current. Every reader
  must go through the collector's freshness (billing's systems read does).

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Show `lastSuccessfulCollectionAt` age per panel as the health | That is the watchdog's per-panel view. It ages every panel when *we* stop, which blames them all (gap 3) |
| Restart the collector on crash (`air` rerun, Swarm restart) and nothing else | Needed, and it is in F-027-ek. But a wedged loop, a cut egress or a long crash still leave stale states shown as current |
| Flip state on the first failure | One lost packet would alert the owner. At 200 panels a minute that is constant noise, and it trains people to ignore the alert |
| One `down` with the raw error string as the detail | The string carries the panel's secret base path and reads as noise to an owner. A closed cause set can be translated, and the page can say what to do for each |

## Revisit trigger

More than one collector instance writing states for the same panel (the
heartbeat already keys on instance, the confirmation count does not), or a
panel fleet large enough that a 5-host / 80% mass rule fires on a single
provider's real outage.
