---
id: redis-keyspace
layer: platform
updated: 2026-09-11
---

# Open questions — redis-keyspace

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `fx:rate:<code>` is referenced only in schema comments; no code writes it. Keep it in the catalogue as reserved? | no | ASSUMED(2026-09-04): reserved for the future `currency` service | -> currency unit |
| 2026-09-04 | The prefix is duplicated in TS and Go with only a comment keeping them in sync. Worth a shared generated constant or a test? | closed | **Closed 2026-09-11 by F-075** — `contracts/redis/keyspace.json` plus a test in each language (ADR-0036). | -> done (`contract.md`) |
| 2026-09-04 | Bumping `REDIS_KEYSPACE_VERSION` logs everyone out. Is there a runbook for doing it deliberately (and for a rollback)? | no | ASSUMED(2026-09-04): documented in operations when first needed | -> operations/runbook |
| 2026-09-09 | `botlink:chat:<platform>:<chatId>` is the one phone-adjacent key F-065-c left tenant-free. **Closed 2026-09-09 by F-066-l** — the key is now `botlink:chat:<tenantId>:<platform>:<chatId>`, built through the same `tenantSegment` its two neighbours use. No keyspace version bump: the orphaned pointers live 900s and their owners re-request a link. | closed | — | -> done (`contract.md`) |
| 2026-09-09 | This unit now reads `tenant-context`, which reads `tenant`, which reads this unit for `tenant:host:*` — a cycle in the unit graph (§8). | no | ASSUMED(2026-09-09): accepted. The edge is ADR-0024's ("the same context serves the Redis key builders") and the alternative is threading a tenant id through `OtpStore`, `BotLinkStore` and their callers, which is the enforcement-by-memory that ADR rejects. Nothing checks for cycles today | -> an ADR if a third unit joins the ring |
| 2026-09-11 | Unifying on `v2` is safe in dev because nothing under that prefix predates ADR-0023. Does any deployed Redis still hold pre-ADR-0023 keys under `v2`? If so they are resurrected into collision with current-shape keys. | no | ASSUMED(2026-09-11): no. `.env` has said `v2` throughout and no deployment has ever run a keyspace older than the current key shapes for long enough to matter. Scan before the first prod deploy that carries this change | -> operations/runbook, or a bump to `v4` |
