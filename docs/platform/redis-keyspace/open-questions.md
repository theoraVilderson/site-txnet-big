---
id: redis-keyspace
layer: platform
updated: 2026-09-09
---

# Open questions — redis-keyspace

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `fx:rate:<code>` is referenced only in schema comments; no code writes it. Keep it in the catalogue as reserved? | no | ASSUMED(2026-09-04): reserved for the future `currency` service | -> currency unit |
| 2026-09-04 | The prefix is duplicated in TS and Go with only a comment keeping them in sync. Worth a shared generated constant or a test? | no | ASSUMED(2026-09-04): a cross-language test asserts the prefix later | -> operations / CI |
| 2026-09-04 | Bumping `REDIS_KEYSPACE_VERSION` logs everyone out. Is there a runbook for doing it deliberately (and for a rollback)? | no | ASSUMED(2026-09-04): documented in operations when first needed | -> operations/runbook |
| 2026-09-09 | `botlink:chat:<platform>:<chatId>` is the one phone-adjacent key F-065-c left tenant-free. **Closed 2026-09-09 by F-066-l** — the key is now `botlink:chat:<tenantId>:<platform>:<chatId>`, built through the same `tenantSegment` its two neighbours use. No keyspace version bump: the orphaned pointers live 900s and their owners re-request a link. | closed | — | -> done (`contract.md`) |
| 2026-09-09 | This unit now reads `tenant-context`, which reads `tenant`, which reads this unit for `tenant:host:*` — a cycle in the unit graph (§8). | no | ASSUMED(2026-09-09): accepted. The edge is ADR-0024's ("the same context serves the Redis key builders") and the alternative is threading a tenant id through `OtpStore`, `BotLinkStore` and their callers, which is the enforcement-by-memory that ADR rejects. Nothing checks for cycles today | -> an ADR if a third unit joins the ring |
