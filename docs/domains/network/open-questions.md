---
id: network
layer: domain
updated: 2026-09-04
---

# Open questions — network

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Traffic ingestion source: does the node panel push to us, or do we poll x-ui APIs? On what interval? | yes | ASSUMED(2026-09-04): a poller worker in `automation` pulls x-ui stats every N minutes | -> ADR + automation unit |
| 2026-09-04 | Partitioning must be a hand-written migration Prisma won't generate. Who owns that SQL and its rollout? | yes (data model) | ASSUMED(2026-09-04): a dedicated migration + a partition-maintenance cron | -> operations/migrations.md |
| 2026-09-04 | HA pair failover (`pairedNodeId`, `role active/passive`) — automatic or manual? | no | ASSUMED(2026-09-04): manual admin action initially | -> rules.md |
| 2026-09-04 | Does provisioning happen on payment success (billing) synchronously, or via a queue? | yes | ASSUMED(2026-09-04): synchronous service call for now | -> ADR (event transport) |
