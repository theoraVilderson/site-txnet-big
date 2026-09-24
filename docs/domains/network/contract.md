---
id: network
layer: domain
status: draft
version: 15
updated: 2026-09-24
---

# Contract — network

**DRAFT — the schema plus a service that does not serve it yet.** The shapes
below are from `txnet-backend/prisma/domains/network.prisma`; no route serves
them. The config actions run in-process (F-027-z) and the panel side runs in
`network-service/`, a Go deployable (ADR-0071, F-027-h).

## TL;DR

A Config is one user's credential (`uuid` + protocol) on one Panel — the x-ui /
Xray server install. `tenantId` is denormalized onto `config` (first key of a
composite index) so a tenant's User panel can query its configs without a join.
`Panel.tenantId = null` = shared pool; set = dedicated to that tenant, and
`ownershipType` says the same thing where the reader does not carry RLS.

A Panel also **declares** how it is driven and how it counts (`driverType`,
`counterSemantics`, `transport`, `capabilities`) — see `data-model.md`. Those
answers select behaviour: three delta arithmetics behind one normaliser, and a
panel refused at registration rather than at billing time (ADR-0074).

## The service (F-027-h)

`network-service/` is a Go module and a `go.work` member. It connects with one
`pgx` pool as a member of `txnet_cross_tenant` — the collector spans every
tenant, so it has no per-tenant scope to fall back on — and it refuses to boot
against a connection that is not a member of that role.

Prisma owns the schema and this service writes no migrations, so at boot it
reads `information_schema` and refuses to start naming every `network.*` column
it depends on that the database does not have
(`network-service/internal/db/schema.go`, `RequiredColumns`). A row that starts
reading a new column adds it to that manifest in the same change.

**Nothing here answers a user request.** Its only HTTP surface is `/health`
(200, or 503 when the database is unreachable), for the container and the
watchdog. Its compose service carries no `traefik.*` label at all and sits on
the private network — a router in front of it would turn "the collector sees
every tenant" into "whoever reaches this route sees every tenant". That is a
consequence of the cross-tenant role, not a preference.

## The driver contract (F-027-i)

`network-service/internal/driver/` is the panel abstraction. One interface
covers all thirteen families, and nothing outside the package knows what an
inbound, a UUID or an x-ui session cookie is — which is what keeps a family's
quirk from reaching the normaliser as a special case (ADR-0074).

`Driver` is catalog 7.1's sketch plus three methods it does not have.
`SetClientDataLimit` writes the panel's own per-user ceiling and is what makes
ADR-0072 possible at all: it is the one enforcement point that still works
while this service is down. `SetClientRateLimit` is the same for bandwidth.
`GetUsageFor` takes a named subset, so the hot loop over the few configs near
their ceiling does not cost a pass over all 5000 (F-027-u).

`GetUsage` returns every client in **one** call, and that is the contract
rather than an optimisation — catalog 8.4 forbids per-client reads and
F-027-k asserts the request count. `ListClients` is its counterpart for
state rather than bytes: the ceiling, rate and expiry the panel is
**enforcing**, never the ones we last asked for. Both comparisons built on it —
applied against allocated (F-027-t) and the three-key drift match (F-027-aa) —
are worthless read from our own side of the write.

**Every error a driver returns is a `*driver.Fault`** with one of six kinds
(v4, F-027-j). A bare error tells the loop nothing it can act on, and the
distinction that pays for the type is `429` against `5xx`: a rate limit is a
healthy panel asking for a slower caller, a `5xx` is a panel that is failing.
Conflating them either quarantines a panel we were rude to or keeps hammering
one that is down. `rate_limited` and `blocked` (`401`/`403`) together are
F-027-v's `throttled_or_blocked`; `unavailable` is its `down`; `timeout` is our
own deadline and implicates the panel in nothing. Classification happens in the
driver, so nothing above it reads a status code.

Byte figures are raw readings, never deltas: what a `ClientUsage` means
depends on the panel's declared `counterSemantics`, and turning the three
meanings into one delta stream is the normaliser's job (F-027-l). A family
that reports a single total puts it in `DownBytes` and leaves `UpBytes` zero,
because a split we invented is a number nobody measured.

## The acceptance questionnaire (F-027-i, ADR-0074)

Sixteen fixed rows, answered by `Driver.Capabilities` as a connection test at
registration and never by hand, stored as the `panel.capabilities` JSONB
document and validated on write — the column holds no shape, so
`driver.Capabilities.Validate` is the shape. It refuses a document that omits
an in-scope row, answers a row this transport is never asked, invents a row the
questionnaire does not have, or carries a version this service cannot read.

Every row changes behaviour; a row that changed none would be a comment. Three
severities say what an unmet answer costs, and `driver.Capabilities.Verdict`
turns them into the `reviewState` the panel is registered with:

| severity | unmet answer | verdict |
|---|---|---|
| `required` | the panel cannot carry users at all — no per-client figure, no bulk endpoint on a `pull` panel, no enable/disable, no client lifecycle | `refused`, at registration rather than at billing time |
| `metered` | it cannot enforce a ceiling, or its ceiling counts different bytes than its counter | accepted; metered sale withheld. Prepaid or refused outright is the owner's call (F-027-aj) |
| `degrades` | the system does something else — holds bytes past 4 GB without Gigawords, re-reads a cursor a panel zeroes on update, falls back to the claim tag when a rename moves an id | accepted, and written down |

`counterSemantics = reset_on_read` is accepted only as `accepted_low_trust`:
a read whose publish fails loses those bytes permanently, so the source is
marked and its loss window bounded to one interval.

The sixteen row keys cross a process boundary — written here in Go, read by
the panel's capability matrix and registration refusal in TypeScript
(F-027-ad). There is no import that could join the two, so their declared home
is `contracts/network/capabilities.json` with a test on each side, exactly as
ADR-0036 requires; the Go half is `internal/driver/questionnaire_test.go`.

## The fake panel and the conformance suite (F-027-j)

A wrong declaration is a **silent wrong number**, not a crash. So the pipeline
above the driver is built and proved against a source that does what real
panels do, before we own one: `internal/driver/fake` is a behaviour model of a
far end — it resets its counter, comes back from a backup, stalls past a
deadline, wraps at 32 bits, omits Gigawords, leaves a session with no `Stop`,
refuses a ceiling and applies one late. It answers the questionnaire from what
it will actually do, so switching a row off in `fake.Config` changes behaviour
where a real family's gap would.

`internal/driver/conformance` is what "conforms" means: fifteen scenarios, run
through the `Driver` interface only. It asserts that a driver **reports what
the far end said** — a reset arrives as a lower raw figure, an implausible
figure arrives at full size, an abandoned session never grows — because
repairing, clamping or extrapolating in a driver destroys the evidence the
normaliser decides on (F-027-l) and bills the repair instead.

A driver's own test supplies a `conformance.Harness`: the driver, plus its far
end scripted. The fake is both halves at once; a real family is a driver over a
scripted HTTP server of its own, and the suite is written to that split. Every
real family — Marzban (F-027-ae), then F-027-ag, F-027-ah, F-027-ai — is an
implementation plus a call to `conformance.Run`: [contract.drivers.md](contract.drivers.md). A family
that cannot be put into a scenario's shape skips it **by name**, so a gap is
reported rather than passed.

## Request volume, and the pacing every family shares (F-027-k)

Four of the fifteen scenarios count requests instead of reading bytes, at the
far end rather than inside the driver. A driver can be right about every
figure and still be a flood on a customer's own server, and that failure has
no wrong reading to inspect: 5000 clients read one at a time is ~1000 req/s
against a machine we do not own. Catalog 8.4 forbids it; these assert it. A
bulk pass over 5000 clients is **one** request, and a hot pass (F-027-u) is one
per panel whether the family has a subset endpoint or serves the subset from
its bulk call.

The other two belong to `driver.Pace`, the layer every family is wrapped in
rather than reimplements. Concurrent whole-panel reads **share one flight** —
a slow panel is exactly when callers pile up behind it — and it is
single-flight, not a cache: a caller arriving after the flight lands gets a
fresh read, because a reading served from memory is a figure nobody measured
at the moment it was billed. And no panel is asked more often than its own
`maxRequestsPerMinute`: a call that would cross the budget **waits for its
slot**, never fails, since a dropped read is a hole in a counter somebody is
charged from (invariant 18). Writes pay the budget but never share a flight —
two identical writes are two intentions.

`Pace` panics on a non-positive budget rather than picking a reading of it:
the figure comes from a column the database CHECKs (invariant 12). Building
that `Budget` from the panel row, the states a `429`/`403` and a `5xx` are
told apart into, and the rate a pass writes back are F-027-v and are
[contract.budget.md](contract.budget.md).

## The collection loop (F-027-l)

`internal/collect/` is one bulk pass a minute that turns three counter
arithmetics into one delta stream, and `internal/publish` is where that pass
leaves the process (F-027-m). Their rules — the maths, reset detection, the
stretched plausibility cap, where a byte waits, and the one message a pass
becomes — are [contract.collection.md](contract.collection.md).

## The nightly rollup (F-027-o)

`network_traffic_rollup` in `worker-service` turns raw traffic into
`traffic_daily_aggregate` and drops the raw months it has covered. The
ordering that makes that safe — the drop refuses a partition the aggregate
does not match — is [contract.rollup.md](contract.rollup.md).

## The ceiling (F-027-s, F-027-t)

`CeilingAllocatorService` in `billing-service` splits a Grant's
`purchasedBytes` across the configs that draw on it and writes each share to
`config.allocatedCeilingBytes` — `Σ ceilings ≤ purchasedBytes`, always
(ADR-0072 rule 1). How a share is sized, which configs are in the split, and
why the sub-account cap wins are [contract.ceiling.md](contract.ceiling.md).
`internal/converge` carries that number to the panel enforcing it, on the same
pass that read its counters — so a ceiling the reset invalidated is rewritten
before another interval runs under it. Same file. Extending it on shutdown,
the watchdog and the health flag: [contract.resilience.md](contract.resilience.md).

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| provision / move / retire config (F-027-z) | grantId, panelId, protocol, actor | desired state on `config` + `config_action_log`; **no panel call** — `internal/converge` carries it ([contract.provisioning.md](contract.provisioning.md)) | sync, caller's tx | `grant_not_active`, `panel_not_found`, `config_retired` |
| regenerate config (F-027-z) | configId, actor | new `uuid`, `regenerateUsedCount++`, held in the write | sync, caller's tx | `regenerate_limit_reached`, `config_changed` |
| enable / disable config (F-027-z) | configId, reason, actor | `status` + `desiredEnabled` + `config_action_log` row | sync, caller's tx | `actor_not_allowed` for a user |
| ingest traffic | panel -> {configId, up, down, at} | `traffic_raw_log` (partitioned) | async, high volume | — |
| nightly aggregate | window | `traffic_daily_aggregate` rows, upserted per `(configId, date)`; the raw months past retention dropped (F-027-o) | async (`network_traffic_rollup`, seeded `15 3 * * *`) | a drop whose aggregate does not match the partition — refused, run fails |
| add IP rule | cidr, ruleType, limit?, expiry? | `ip_access_rule` | sync | — |

## Emits (events)

| Routing key | What | Consumer |
|---|---|---|
| `network.usage.delta` | one collection pass over one panel: its deltas, its quarantines and its unattributed rows (F-027-m) | `billing-service` metering (F-027-n) |

Declared in `contracts/network/delta.json` and held to it on both sides; the
shape and why it is one message per pass are in
[contract.collection.md](contract.collection.md). No config action is pushed
to a panel: each writes desired state, and one pass carries it (F-027-z).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` owner of a config | provisioning blocked |
| entitlement | the `grant` a config is provisioned for — its status, quotas and `panelGroupId` via its variant (ADR-0049; F-027) | provisioning blocked |
| tenant | `tenantId` denormalized onto panel/config; dedicated Panel pools; a panel's login via the vault's `use` route (F-027-aw) | shared pool still usable; a pending panel stays `pending`, `unopenable` |
| billing | `sub_account` draws down `config` byte caps | metering stops |

## Guarantees (intended)

- `config.uuid` is globally unique (the real Xray uuid).
- `traffic_raw_log` is monthly range-partitioned; old partitions are `DROP`ped
  after aggregation, never row-deleted.
- Layer-1 rate limiting is Redis-only and intentionally has no table; this unit
  is layer-2 (durable rules).
- `panelApiCredentials` is encrypted, never default-selected or logged.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| model/table `Node` (`node`) | 2026-09-06 | removed in the same change | `Panel` (`panel`) — see `docs/GLOSSARY.md` banned words |
| `Panel.panelType` + enum `PanelType` | 2026-09-21 | removed in the same change | `Panel.driverType` + enum `DriverType` (13 families) |
| `Panel.status` + enum `PanelStatus` | 2026-09-21 | removed in the same change | `Panel.panelState` + enum `PanelState`, one value wider |

§8 normally forbids removing a shape in the change that replaces it. All three
were removed outright because the consumer list is empty: no service reads the
model, and `network.panel` has never held a row —
`20260921000100_panel_declares_its_driver` asserts that before it starts. The
`Node` removal additionally had no committed migration.
