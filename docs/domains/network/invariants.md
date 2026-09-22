---
id: network
layer: domain
status: draft
updated: 2026-09-21
---

# Invariants — network

**DRAFT** — 1-7 are from schema comments and not enforced in code. 8-12 are
enforced by the database as of F-027-a, 13-17 as of F-027-b, 19-25 as of
F-027-c, 26-28 as of F-027-d and 2, 30-31 as of F-027-e. 18 and 29 are the
promise the rest of them serve and are service rules; 32 is a service rule too,
and is the one rule of this set that runs before a panel has any rows at all.
33 is a service rule held by the driver conformance suite (F-027-j), and 34 is
its request-volume half (F-027-k). The pull half of 18 is enforced as of
F-027-l; its push half waits for F-027-af.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `config.uuid` is unique across the whole system (it is the Xray identity) | schema `@unique` | cross-user traffic attribution, credential clash |
| 2b | A tenant reads only its own `traffic_raw_log` rows, through the parent **or** a partition named directly; every month the partition function creates is policied as it is created (F-027-ak) | RLS on the parent and each partition, `ensure_traffic_raw_log_partition()` | one tenant reads another's traffic under a table name derived from the month |
| 2 | `traffic_raw_log` is only ever appended and dropped by partition — never `DELETE`d row-wise | monthly `PARTITION BY RANGE ("recordedAt")` (F-027-e) | vacuum bloat on the largest table in the platform, competing with the collection loop for the same pages |
| 3 | Daily aggregate is computed before its source raw partition is dropped | `network.drop_traffic_raw_log_partition` refuses a partition the aggregate does not match (F-027-o), asserted by `traffic-rollup.job.spec.ts` | permanent traffic-data loss |
| 4 | `regenerateUsedCount` never exceeds `maxRegenerateCount` | planned service check | abuse of free re-issue |
| 5 | `panelApiCredentials` (encrypted) never default-selected or logged | planned `select`/`omit` | node panel takeover |
| 6 | Every `config` has a non-null `tenantId` (denormalized, must match the owner user's tenant) | schema NOT NULL + planned service check | cross-tenant config listing |
| 7 | A panel in `maintenance` / `down` / `throttled_or_blocked` state receives no new configs | planned provisioning check | provisioning onto a dead node |
| 8 | Every Panel declares `driverType`, `counterSemantics` and `transport` | schema NOT NULL, no default (F-027-a) | usage counted by the wrong arithmetic — a plausible wrong number, not a crash |
| 9 | `ownershipType = tenant` exactly when `tenantId` is set | CHECK `panel_ownership_matches_tenant` | an alert routed to the wrong owner, or a tenant's cost billed to the platform |
| 10 | A `pull` panel has an `apiBaseUrl` | CHECK `panel_pull_has_base_url` | a driver guessing a base URL per family |
| 11 | `blockedSince` is set exactly while `panelState = throttled_or_blocked` | CHECK `panel_blocked_since_needs_state` | no clock on a ban, so retrying through it makes it permanent |
| 12 | `maxRequestsPerMinute` is positive | CHECK `panel_request_budget_positive` | a budget of zero stops collection on that panel silently |
| 13 | A ceiling, allocated or applied, is never negative | CHECK `config_ceiling_bytes_not_negative` | a limit written to a panel that no traffic fits under — the user is cut off holding paid bytes |
| 14 | `ceilingAppliedAt` is set exactly when `appliedCeilingBytes` is | CHECK `config_applied_ceiling_needs_time` | no clock on the write, so a stale ceiling reads as a fresh one and is never rewritten |
| 15 | A completed purge holds no `remoteId` | CHECK `config_purged_has_no_remote_id` | the loop adopts a panel seat it has just freed, and usage is attributed to a client that is gone |
| 16 | One remote client belongs to one config | UNIQUE `(panelId, remoteId)` | one client's traffic counted against two configs, or a ceiling written twice with two different numbers |
| 17 | `claimTag` is unique across the whole system | schema `@unique` | the second matching key matches the wrong row, which is invariant 1's failure reached the long way round |
| 18 | Every measured byte ends billed, held or quarantined — never dropped | `internal/collect` on the pull side (F-027-l), asserted by `collect_test.go`; the push side is F-027-af and the consumer F-027-n | the thing ADR-0074 exists to prevent: usage lost in silence, which nobody can detect after the fact |
| 19 | One delta is applied at most once | PK `usage_delta_seen.deltaId` | a redelivered message charges the user twice, and at-least-once delivery guarantees a redelivery |
| 20 | One config has at most one counter cursor | UNIQUE `config_counter_state.configId` | two opinions about where the counter was; the losing one re-counts everything since the last reset |
| 21 | No byte figure anywhere is negative | CHECKs `*_bytes_not_negative` | a counter going backward is a reset, never negative usage — a negative delta credits traffic nobody bought |
| 22 | A hold or quarantine carries a resolution time exactly when it is resolved | CHECKs `usage_hold_resolved_has_time`, `usage_delta_quarantine_resolved_has_time` | a row resolved at no time cannot be aged, audited or reported on, and the queue stops being evidence |
| 23 | A drift event's affected count never exceeds what it observed | CHECK `panel_drift_event_counts_sane` | a ratio above 100% — an arithmetic bug reading as a worse event than happened, on the verdict that halts collection |
| 24 | One remote client on one panel has one unattributed row | UNIQUE `unattributed_usage_panel_remote_key` | one unclaimed client becomes a row a minute; the report that should name it becomes unreadable |
| 25 | Unattributed usage called `attributed` names the config it went to | CHECK `unattributed_usage_attributed_has_config` | bytes dropped under a state that says they were not — invariant 18's failure, wearing a resolved label |
| 26 | One `Acct-Session-Id` on one NAS is one session | UNIQUE `radius_session_nas_acct_key` | two NASes numbering their sessions from 1 collide, and one user's traffic lands on another's session |
| 27 | A session publishes no more than it measured | CHECK `radius_session_published_within_high_water` | the extrapolation past a missing `Stop` that ADR-0074 forbids, reaching the user as a charge for traffic nobody watched happen |
| 28 | A closed session says why it closed | CHECK `radius_session_closed_has_reason` | a stale session's last figure cannot be told from a real `Stop` figure, so the weaker number is billed as the stronger one |
| 29 | A session past 4 GB whose NAS never sent Gigawords is held, not billed | planned service rule (`radius_session.gigawordsSeen` makes it expressible) | 4 GB per wrap lost in silence — invariant 18's failure on the push side, and the one ADR-0074 names |
| 30 | One rollup row per `(configId, date)` | UNIQUE `traffic_daily_aggregate_config_date_key` (F-027-e) | a cron rerun doubles a day's reported usage, with both rows individually correct — which is what makes it invisible |
| 31 | A measured byte lands in a partition that retention will reach, or the insert fails | monthly partitions with **no** `DEFAULT` partition (F-027-e) | the one partition nobody can drop keeps an uncreated month's rows past every retention rule, in silence |
| 32 | A panel failing a load-bearing acceptance row never carries users, and one that cannot enforce a per-client ceiling never sells metered service | `driver.Capabilities.Verdict` (F-027-i), asserted by `questionnaire_test.go` | a family whose figures we cannot bill is discovered at billing time, with users already on it — and a metered sale with no enforceable ceiling serves bytes nobody paid for (ADR-0072) |
| 34 | A pass over a panel costs one request — bulk or hot — and no panel is asked more often than its `maxRequestsPerMinute` | `driver.Pace` + the four request-volume scenarios of `internal/driver/conformance` (F-027-k) | 5000 clients read one at a time is ~1000 req/s at a machine we do not own: our own collector as a denial of service, arriving as the customer's outage and our address banned (catalog 8.4) |
| 33 | A driver reports what the far end said — it never repairs a reset, clamps an implausible figure, extrapolates past a missing `Stop` or reassembles bits the NAS did not send | the eleven scenarios of `internal/driver/conformance` (F-027-j), run by every driver's own test | the evidence the normaliser decides on is destroyed inside the driver, and the repair is billed as a measurement — a plausible wrong number with nothing red anywhere (ADR-0074) |

## How to test

Invariants 8-17 and 19-25 are held by the schema and the migration history,
and that those two agree is asserted by
`shared-core/src/lib/prisma/network-panel-declaration.spec.ts` (8-12),
`network-config-desired-state.spec.ts` (13-17) and
`network-usage-accounting.spec.ts` (19-25),
`network-radius-session.spec.ts` (26-28) and
`network-traffic-partitioning.spec.ts` (2, 30-31) — schema and migrations
agreeing, in CI. That the *running* service agrees with both is the boot
assertion ADR-0071 asked for, and it exists as of F-027-h:
`network-service/internal/db/schema.go` refuses to start on a missing column.

18 is not a schema rule and cannot become one: it is the collection loop
(F-027-l) and the delta consumer (F-027-n) accounting for every byte they
read. The pull half exists: `network-service/internal/collect` puts every
reading in exactly one of deltas, quarantine and `unattributed_usage`, moves a
cursor only after its pass is published, and leaves the cursor alone when a
panel times out or fails — `collect_test.go` asserts each of those as a
behaviour, against the fake panel resetting, restoring a backup and stalling.
The consumer's half exists as of F-027-n: `metering-service` puts every
figure a pass carries in exactly one of billed, held, quarantined and
unattributed, and `metering.service.spec.ts` asserts that as a sum over a
mixed pass — bytes in equals bytes landed. 19 is the same file's other
assertion: a redelivered pass applies once, with the pre-read defeated.
29 is the same rule on the push side and belongs to the receiver (F-027-af).

32 is registration-time and is held by `network-service/internal/driver`:
`questionnaire_test.go` asserts the refusal, the withheld metered sale and the
low-trust verdict against answer sheets, and pins the 16 row keys to
`contracts/network/capabilities.json` so the TypeScript side reads the same
questionnaire (ADR-0036).

34 is held by `internal/driver/pace.go` — single-flight and the per-window
budget, written once for all thirteen families — and asserted over each of them
by the four request-volume scenarios, which count at the far end through
`conformance.Harness.TotalCalls`. Wiring the budget to the panel row is
F-027-v.

3 is the other half of 2 and is no longer the job's to remember: the drop
function counts the `(configId, date)` groups whose aggregate row is missing or
differs and raises rather than dropping, so getting the order wrong in a caller
fails loudly instead of losing a month ([contract.rollup.md](contract.rollup.md)).
The rest is to be written with the service.
Minimum: regenerate cap test.
