---
id: network
layer: domain
status: draft
updated: 2026-09-26
---

# Invariants — network

**DRAFT** — 1-7 are from schema comments and not enforced in code, except 4
(F-027-z); 39-40 are F-027-z's. 8-12 are
enforced by the database as of F-027-a, 13-17 as of F-027-b, 19-25 as of
F-027-c, 26-28 as of F-027-d and 2, 30-31 as of F-027-e. 18 and 29 are the
promise the rest of them serve and are service rules; 32 is a service rule too,
and is the one rule of this set that runs before a panel has any rows at all.
33 is a service rule held by the driver conformance suite (F-027-j), and 34 is
its request-volume half (F-027-k). The pull half of 18 is enforced as of
F-027-l, its push half as of F-027-af (`internal/radius`).

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `config.uuid` is unique across the whole system (it is the Xray identity) | schema `@unique` | cross-user traffic attribution, credential clash |
| 2b | A tenant reads only its own `traffic_raw_log` rows, through the parent **or** a partition named directly; every month the partition function creates is policied as it is created (F-027-ak) | RLS on the parent and each partition, `ensure_traffic_raw_log_partition()` | one tenant reads another's traffic under a table name derived from the month |
| 2 | `traffic_raw_log` is only ever appended and dropped by partition — never `DELETE`d row-wise | monthly `PARTITION BY RANGE ("recordedAt")` (F-027-e) | vacuum bloat on the largest table in the platform, competing with the collection loop for the same pages |
| 3 | Daily aggregate is computed before its source raw partition is dropped | `network.drop_traffic_raw_log_partition` refuses a partition the aggregate does not match (F-027-o), asserted by `traffic-rollup.job.spec.ts` | permanent traffic-data loss |
| 4 | `regenerateUsedCount` never exceeds `maxRegenerateCount` | `ConfigActionsService.regenerate`, the count it read in the write's own `where` (F-027-z), asserted by `config-actions.spec.ts` | abuse of free re-issue |
| 5 | `panelApiCredentials` (encrypted) never default-selected or logged | planned `select`/`omit` | node panel takeover |
| 6 | Every `config` has a non-null `tenantId` (denormalized, must match the owner user's tenant) | schema NOT NULL + planned service check | cross-tenant config listing |
| 7 | A panel in `maintenance` / `down` / `throttled_or_blocked` state receives no new configs | planned provisioning check | provisioning onto a dead node |
| 8 | Every Panel declares `driverType`, `counterSemantics` and `transport` | schema NOT NULL, no default (F-027-a) | usage counted by the wrong arithmetic — a plausible wrong number, not a crash |
| 9 | `ownershipType = tenant` exactly when `tenantId` is set | CHECK `panel_ownership_matches_tenant` | an alert routed to the wrong owner, or a tenant's cost billed to the platform |
| 10 | A `pull` panel has an `apiBaseUrl` | CHECK `panel_pull_has_base_url` | a driver guessing a base URL per family |
| 11 | `blockedSince` is set exactly while `panelState = throttled_or_blocked` | CHECK `panel_blocked_since_needs_state`; set once by `panelstate.Judge` and never restarted by a later refusal (F-027-v) | no clock on a ban, so retrying through it makes it permanent |
| 12 | `maxRequestsPerMinute` is positive | CHECK `panel_request_budget_positive` | a budget of zero stops collection on that panel silently |
| 13 | A ceiling, allocated or applied, is never negative | CHECK `config_ceiling_bytes_not_negative` | a limit written to a panel that no traffic fits under — the user is cut off holding paid bytes |
| 14 | `ceilingAppliedAt` is set exactly when `appliedCeilingBytes` is | CHECK `config_applied_ceiling_needs_time` | no clock on the write, so a stale ceiling reads as a fresh one and is never rewritten |
| 15 | A completed purge holds no `remoteId` | CHECK `config_purged_has_no_remote_id` | the loop adopts a panel seat it has just freed, and usage is attributed to a client that is gone |
| 16 | One remote client belongs to one config | UNIQUE `(panelId, remoteId)` | one client's traffic counted against two configs, or a ceiling written twice with two different numbers |
| 17 | Every config has a `claimTag`, unique across the whole system | NOT NULL (`20260923000200`) + schema `@unique`, written by `ConfigActionsService.provision` (F-027-aa) | the second matching key matches the wrong row, which is invariant 1's failure reached the long way round |
| 18 | Every measured byte ends billed, held or quarantined — never dropped | `internal/collect` on the pull side (F-027-l), asserted by `collect_test.go`; `internal/radius` on the push side (F-027-af), asserted by `radius_test.go`; the consumer F-027-n | the thing ADR-0074 exists to prevent: usage lost in silence, which nobody can detect after the fact |
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
| 29 | A session past 4 GB whose NAS never sent Gigawords is held, not billed | `radius.Account` splits the rise at 4 GB and the part past it is a `gigawords_missing` `usage_hold` row (F-027-af, `radius_test.go`) | 4 GB per wrap lost in silence — invariant 18's failure on the push side, and the one ADR-0074 names |
| 30 | One rollup row per `(configId, date)` | UNIQUE `traffic_daily_aggregate_config_date_key` (F-027-e) | a cron rerun doubles a day's reported usage, with both rows individually correct — which is what makes it invisible |
| 31 | A measured byte lands in a partition that retention will reach, or the insert fails | monthly partitions with **no** `DEFAULT` partition (F-027-e) | the one partition nobody can drop keeps an uncreated month's rows past every retention rule, in silence |
| 32 | A panel failing a load-bearing acceptance row never carries users, and one that cannot enforce a per-client ceiling never sells metered service | `driver.Capabilities.Verdict` (F-027-i), asserted by `questionnaire_test.go` | a family whose figures we cannot bill is discovered at billing time, with users already on it — and a metered sale with no enforceable ceiling serves bytes nobody paid for (ADR-0072) |
| 34 | A bulk pass costs one request, or one per page of at least 100 (ADR-0081); a hot pass costs one; every page is paid for in the budget, and no panel is asked more often than its `maxRequestsPerMinute` | `driver.Pace` + `driver.NextPage` + the four request-volume scenarios of `internal/driver/conformance` (F-027-k, F-027-bf) | 5000 clients read one at a time is ~1000 req/s at a machine we do not own: our own collector as a denial of service, arriving as the customer's outage and our address banned (catalog 8.4) |
| 35 | A ceiling written to a panel is never above that config's `allocatedCeilingBytes`, whatever the panel's own counter already holds — except on the way out, where 37 bounds it | `converge.PanelCeiling` clamps both ends of the translation (F-027-t), asserted by `converge/ceiling_test.go` | headroom handed out for bytes nobody bought — the counter's unbilled baseline turned into free traffic, which is ADR-0072's hole reopened one config at a time |
| 36 | `appliedCeilingBytes` is only ever set from what the panel reports it is enforcing | `converge.Ceilings.Pass` records from `ListClients` and never from its own write (F-027-t) | a ceiling a family took late, or never, reads as applied: the gap to `allocated` goes to zero and the loop stops trying, with nothing red anywhere |
| 37 | A shutdown raises a ceiling only up to `walletBackedCeilingBytes`, never lowers one, never writes zero, and records nothing as applied | CHECK `config_wallet_backed_ceiling_extends` (≥ the allocation) + `shutdown.Extender` (F-027-w), asserted by `shutdown_test.go` and the allocator's property test | a deploy either cuts off every metered user with money in their wallet, or — removing the ceiling instead — serves traffic nobody bought while nothing is counting (ADR-0078) |
| 38 | `lastSuccessfulCollectionAt` is stamped only for a panel whose turn published and moved its cursor | `collect.Loop.stamp` (F-027-w), asserted by `collect_test.go` | a watchdog that reports health it never observed: a wedged collector stays green, and users stall before anyone is told |
| 33 | A driver reports what the far end said — it never repairs a reset, clamps an implausible figure, extrapolates past a missing `Stop` or reassembles bits the NAS did not send | the eleven scenarios of `internal/driver/conformance` (F-027-j), run by every driver's own test | the evidence the normaliser decides on is destroyed inside the driver, and the repair is billed as a measurement — a plausible wrong number with nothing red anywhere (ADR-0074) |
| 39 | A retired config is never wanted on a panel, and a top-up revives only `active` configs | CHECK `config_retired_is_absent` + `reviveOnTopUp`'s `where` (F-027-z) | a config the user deleted, or the old seat of one that moved, is rebuilt by the next top-up |
| 40 | Only the convergence pass calls a panel's client-lifecycle methods; a client is created under its ceiling, and `enforcementState = complete` / a cleared `remoteId` come only from a read | `converge.Provisioning` (F-027-z), asserted by `provision_test.go` | a create with no limit is unpaid traffic; a delete believed from our own write frees a seat the panel still holds |
| 41 | A remote client is matched to at most one config, by `remoteId`, then `claimTag`, then `uuid`, each key over what the ones before left unclaimed; a client matched by no key is recreated only as a repair, under the anti-flap stop | `converge.MatchClients` (F-027-aa), asserted by `drift_test.go` | a rename is a vanished client: its usage unattributed and the user cut off, or a second seat created beside the renamed one |
| 42 | No more than two repairs of one config within 24 hours of each other, and a ceiling that allows more than ours is rewritten whatever the count; a repair count always has a time | `converge` (`MaxRepairs`, `RepairWindow`, `held`) + CHECK `config_drift_repair_has_a_time` (F-027-ab), asserted by `containment_test.go` | a loop and another writer undoing each other every minute, with nothing red anywhere — or a raised ceiling left standing because the config was "contested", which is free traffic |
| 43 | A pass in which more than 20% (and at least five) of a panel's cumulative counters go backward publishes none of their post-reset bytes, and the panel is not read again until the event is acknowledged | `collect.Containment` in both loops, before the publish (F-027-ab), asserted by `containment_test.go` | a backup restore billed as thousands of plausible resets: the restored figures charged twice, ~$16k in a minute |
| 44 | A panel is read or converged only while its `reviewState` is `accepted` or `accepted_low_trust`, and a verdict is written only from answers that validated, only over `pending`; a test that gave none leaves the panel `pending` with its fault | `register.Registrar` + `collect.Loop.Pass` (fails closed) + CHECK `panel_connection_fault_is_pending_only` (F-027-aq), asserted by `register_test.go` and `collect_test.go` | a refused panel provisioned with users on it, or a wrong password recorded as a panel that cannot carry users |
| 45 | A panel is in a panel group once; a platform group holds only platform panels, a tenant's group its own and platform ones, and a group's tenant never changes | PK `(groupId, panelId)` + triggers `panel_group_member_fits`, `panel_group_tenant_is_fixed`, `panel_keeps_its_groups` (F-027-bk), asserted by `network-panel-group.spec.ts` | one reseller's dedicated panel serving every tenant's users, or two configs for one user on one panel |
| 46 | A variant names a platform panel group or its own tenant's; not found under RLS is refused | FK `product_variant_panelGroupId_fkey` + trigger `product_variant_panel_group_fits` + catalog-admin `panel_group_not_found` (F-027-bk) | a reseller selling another tenant's servers ([contract.groups.md](contract.groups.md)) |
| 47 | A Grant's panel-group placement is one config per panel, a drained one aside (F-027-bp), and the Grant activates only on `minHealthyPanels` configs the panel confirmed (`complete`) on a serving panel | partial unique `config_group_panel_once` + `planFulfilment` + `group-fulfilment.spec.ts` | two clients on one panel split the bag; a Grant active with no working server |
| 48 | A drained member's config is retired only `2 × subscriptionTtlSeconds` after `/sub` stopped serving it, and never while it is an active Grant's only served line; `drainingSince` is the database's clock | trigger `panel_group_member_drain_clock` + CHECK `panel_group_member_draining_since_iff_drain` + `planDrain` + sub `servedLines` (F-027-bm), asserted by `group-drain.spec.ts` and `render_test.go` | a user whose app still holds the drain line is cut off ([contract.groups.md](contract.groups.md)) |
| 49 | An archived panel (`retiredAt` set) is read, tested, allowlisted and expected by the watchdog by nothing, and takes no config and no group; it is archived only with no group and no live config | `retiredAt IS NULL` in `panelsSQL`, `pendingSQL`, `nasSQL` and `collection_watchdog()` + triggers `config_panel_not_retired`, `panel_group_member_panel_not_retired` + billing `PanelLifecycleService.remove` (F-027-bz), asserted by `panel-retire.spec.ts` | a panel taken out of service still polled and alerting, or users placed on a server nobody runs any more |
| 50 | A config of an unlimited Grant carries `trafficUnlimited` and never a ceiling; its client is created with no limit, in the family's own no-limit (Hiddify: 1,000,000 GB), never a 0 read as one | CHECK `config_unlimited_has_no_ceiling`; `ConfigActionsService.create`, `Provisioning.create`, `NoDataLimit` per driver (F-111-r, `provision_test.go`, `conformance.NoLimitRoundTrip`) | an unlimited buyer never placed and refunded an hour later, or cut off at a 1-byte ceiling |
| 51 | No two panels share a normalised `apiBaseUrl` (lower-case, default port written out, no trailing `/`, path kept) — archived ones included; several panels on one host differ by port or path (F-027-cd, ADR-0090) | unique index `panel_api_address_key` on `network.panel_api_address("apiBaseUrl")` (20260926001100) + billing `panel-address.ts`

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
29 is the same rule on the push side, held by `internal/radius` (F-027-af).

32 is registration-time and is held by `network-service/internal/driver`:
`questionnaire_test.go` asserts the refusal, the withheld metered sale and the
low-trust verdict against answer sheets, and pins the 16 row keys to
`contracts/network/capabilities.json` so the TypeScript side reads the same
questionnaire (ADR-0036).

34 is held by `internal/driver/pace.go` — single-flight and the per-window
budget, written once for all thirteen families — and asserted over each of them
by the four request-volume scenarios, which count at the far end through
`conformance.Harness.TotalCalls`. `collect.Paced` is where
`panel.maxRequestsPerMinute` becomes that budget, and it panics on the
non-positive figure 12 forbids (F-027-v).

11 is the CHECK plus `internal/panelstate`, which is the only thing that sets
`panelState`: a `429`/`403` starts the clock and alerts the owner once, a
successful pass clears both, and a pass that finds the panel still refusing
leaves the original clock alone — restarting it is a cool-off that can never
elapse. `panelstate_test.go` asserts the table of kinds and both directions of
11; `contract.budget.md` is the rest.

3 is the other half of 2 and is no longer the job's to remember: the drop
function counts the `(configId, date)` groups whose aggregate row is missing or
differs and raises rather than dropping, so getting the order wrong in a caller
fails loudly instead of losing a month ([contract.rollup.md](contract.rollup.md)).
The rest is to be written with the service.
Minimum: regenerate cap test.
