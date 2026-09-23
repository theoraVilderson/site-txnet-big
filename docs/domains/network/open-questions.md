---
id: network
layer: domain
updated: 2026-09-23
---

# Open questions — network

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Traffic ingestion source: does the node panel push to us, or do we poll x-ui APIs? On what interval? | yes | ASSUMED(2026-09-04): a poller worker in `automation` pulls x-ui stats every N minutes | -> ADR + automation unit |
| 2026-09-04 | Partitioning must be a hand-written migration Prisma won't generate. Who owns that SQL and its rollout? | yes (data model) | ASSUMED(2026-09-04): a dedicated migration + a partition-maintenance cron | -> operations/migrations.md |
| 2026-09-04 | HA pair failover (`pairedNodeId`, `role active/passive`) — automatic or manual? | no | ASSUMED(2026-09-04): manual admin action initially | -> rules.md |
| 2026-09-04 | Does provisioning happen on payment success (billing) synchronously, or via a queue? | resolved | **Answered 2026-09-09 by ADR-0021: a transactional outbox.** The producer writes its row and its event in one transaction; a relay delivers them. The "synchronous call until a bus exists" assumption is withdrawn | -> ADR-0021 |
| 2026-09-21 | `traffic_daily_aggregate` has no `tenantId`, so RLS cannot isolate it; a reader reaches it through `configId`. Denormalize a `tenantId` onto it as `traffic_raw_log` has, or leave isolation to the join? | no | SETTLED(2026-09-21, F-027-o): the rollup is written by a `SECURITY DEFINER` function that binds no tenant and read through `config`; nothing serves it to a tenant yet, and the row that does is where a `tenantId` would be decided | -> `contract.rollup.md` |
| 2026-09-22 | The hot loop is two halves in two processes (F-027-u): `network-service` knows which configs are near a ceiling, `billing-service` buys the block. Nothing carries "this Grant is hot" between them — a route, a delta the consumer acts on, or a timer in `billing-service` that scans for hot Grants? | yes (F-027-u has no caller) | ASSUMED(2026-09-22): both halves compute time to ceiling from their own side's data, and `HotLoopService.topUpIn` waits for a caller, as `RemainderCreditService` does. **F-027-w's half is answered** (2026-09-22, user): the shutdown figure waits in `config.walletBackedCeilingBytes`, kept fresh by the allocator — ADR-0078. That does not decide the hot loop's channel | -> ADR, for F-027-u's half |
| 2026-09-23 | `panel.orphanPolicy` has `adopt` and `delete_remote` beside `report_only`. What does `adopt` adopt into — a client we cannot match has no config, and making one needs a user and a Grant — and who may set `delete_remote` on a reseller's panel, where the "orphan" may be the reseller's own customer? | no (F-027-ad shows orphans) | ASSUMED(2026-09-23, F-027-aa): the pass executes `report_only` whatever the policy says; orphans are `ProvisionReport.Orphans` and their bytes `unattributed_usage` | -> `contract.drift.md`, when a policy is built |
