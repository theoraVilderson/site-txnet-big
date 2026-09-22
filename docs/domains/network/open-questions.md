---
id: network
layer: domain
updated: 2026-09-21
---

# Open questions — network

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Traffic ingestion source: does the node panel push to us, or do we poll x-ui APIs? On what interval? | yes | ASSUMED(2026-09-04): a poller worker in `automation` pulls x-ui stats every N minutes | -> ADR + automation unit |
| 2026-09-04 | Partitioning must be a hand-written migration Prisma won't generate. Who owns that SQL and its rollout? | yes (data model) | ASSUMED(2026-09-04): a dedicated migration + a partition-maintenance cron | -> operations/migrations.md |
| 2026-09-04 | HA pair failover (`pairedNodeId`, `role active/passive`) — automatic or manual? | no | ASSUMED(2026-09-04): manual admin action initially | -> rules.md |
| 2026-09-04 | Does provisioning happen on payment success (billing) synchronously, or via a queue? | resolved | **Answered 2026-09-09 by ADR-0021: a transactional outbox.** The producer writes its row and its event in one transaction; a relay delivers them. The "synchronous call until a bus exists" assumption is withdrawn | -> ADR-0021 |
| 2026-09-21 | `traffic_daily_aggregate` has no `tenantId`, so RLS cannot isolate it; a reader reaches it through `configId`. Denormalize a `tenantId` onto it as `traffic_raw_log` has, or leave isolation to the join? | no | SETTLED(2026-09-21, F-027-o): the rollup is written by a `SECURITY DEFINER` function that binds no tenant and read through `config`; nothing serves it to a tenant yet, and the row that does is where a `tenantId` would be decided | -> `contract.rollup.md` |
