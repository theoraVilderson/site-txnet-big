---
id: network
layer: domain
status: draft
version: 11
updated: 2026-09-23
---

# Resilience — nobody is cut off because the collector is not running

A topic file of `contract.md` (§10). What governs
`network-service/internal/shutdown`, the progress mark `collect.Loop` stamps,
the external watchdog on it, and the collection-health flag in the API
(F-027-w, ADR-0078). Read it before changing the exit order, a watchdog
threshold, or what the panel is told while metering is down.

**The collector is the only thing that reads a counter.** While it is down
nothing is measured, nothing buys a block and no ceiling rises — and the
ceilings in force cover about two minutes of each user's own rate
(`contract.hot-loop.md`). Deploys are weekly and crashes rare, so the graceful
path is the one this file is mostly about.

## On the way out: extend, never remove

On `SIGTERM`, before the HTTP server drains, `shutdown.Extender` raises every
active config's panel ceiling to `config.walletBackedCeilingBytes` — the
config's share of a bag of `purchasedBytes` plus what the wallet would buy at
the Grant's locked rate. `billing-service`'s allocator keeps that column fresh
in the transaction that writes `allocatedCeilingBytes`; why a column and not a
call is ADR-0078.

| rule | why it is a refusal and not a preference |
|---|---|
| **only ever raises** | a panel already enforcing more is left alone. A shutdown that lowered a ceiling is the cut-off this exists to prevent |
| **never writes zero** | zero on a panel reads as *no limit*. A user whose money has run out keeps the ceiling they had; cutting off is F-027-x's |
| **translated like any ceiling** | into the counter's own origin, through `converge.OffsetBytes` / `PanelCeiling` — the same functions, so the two cannot drift |
| **still somebody else's server** | one `ListClients` per panel, the budget and the single flight hold, and a panel refusing us is not asked (F-027-v). A ban earned at exit is one nobody is watching for |
| **records nothing** | no `appliedCeilingBytes`, no cursor. The first pass after the restart finds the panel above its allocation and pulls it back as `above_allocation` (F-027-t) |
| **bounded** | `DefaultPanelTimeout` 5s per panel, 8 in flight, inside `HTTP_SHUTDOWN_TIMEOUT`. A budget that runs out leaves the panels it reached extended and the rest as they were — never worse than no extension |

A failure is logged and never fatal: exiting non-zero over it would give the
orchestrator a container to restart in a loop. `cmd/server` holds the exit
**order** today; the extender is nil there until a Postgres-backed `Reserves` lands;
the loop itself runs on `network.*` (F-027-bt).

## The mark, and who reads it

`collect.Loop` stamps `panel.lastSuccessfulCollectionAt` for every panel whose
turn **published and moved its cursor**, once per pass for all of them. A
failed turn is never stamped — a stamp on one is a watchdog reporting health
it never observed. A stamp that fails to write is logged and does not fail the
pass: the bytes are billed by then, and an unwritten clock ages into an alert,
which is the safe direction on its own.

`/health` is not the watchdog and cannot be one: it answers 200 while the
process reaches Postgres, which it does while the loop is wedged on one
panel's credential. The watchdog is outside the process, so it still answers
while the collector is dead:

- `network.collection_watchdog()` — `SECURITY DEFINER`, because the exporter's
  `txnet_app_user` sees only platform panels under RLS. Scope: accepted panels
  not in `maintenance`. `stalest_panel_seconds` is -1 when none in scope was
  ever collected.
- `postgres-queries.yaml` `network_collection` serves it;
  `network.rules.yml` alerts on it.

| alert | fires at | means |
|---|---|---|
| `NetworkCollectionStalled` | > 300s for 5m | five missed passes: not coming back by itself. Warning — nobody is cut off yet |
| `NetworkCollectionStopped` | > 900s for 5m | metered users on that panel are at their ceiling |
| `NetworkPanelNeverCollected` | any, for 30m | accepted and never read: its traffic is counted by nobody |
| `NetworkCollectionWatchdogBlind` | postgres target down 5m | the three above cannot fire |

The thresholds are multiples of `collect.DefaultInterval` (60s). Change the
interval and they move with it.

## What the user is told

`GET /api/billing/traffic/collection-health` — served by `billing-service`,
because that is the user's API edge; the rule is this file's.

| out | |
|---|---|
| `metering` | `healthy`, `unavailable` or `not_metered` (C-09, `METERING_STATES`) |
| `lastCollectedAt` | the stalest panel's last completed pass; null when one never was, or there is nothing |
| `staleForSeconds` | seconds since then; null with it |
| `configsAffected` | the user's configs on a panel past the threshold |

- **`STALE_AFTER_SECONDS` is 300**, the figure `NetworkCollectionStalled`
  warns at. The panel and the operators' alert are one answer to one question.
- **Never collected is `unavailable`**, never healthy: nothing was measured.
- **Only configs that can carry traffic** — `active` and `desiredEnabled`. A
  disabled config on a stalled panel is not a service anybody is using.
- The user is the gate's `X-User-Id`; its own bucket
  (`TRAFFIC_COLLECTION_HEALTH`, 180/900s) and the `subscriptionLink`
  capability, as the Grant list has.

The sentence the panel shows — *metering is unavailable, your service is not
cut off* — is F-027-ac's to write; this route is what it is keyed on.

## What it will not do

It does not keep a collector running across a deploy (ADR-0078's revisit
trigger), decide the hot loop's channel (still open), or cut anybody off:
suspension is F-027-x and `desiredEnabled` is F-027-z.
