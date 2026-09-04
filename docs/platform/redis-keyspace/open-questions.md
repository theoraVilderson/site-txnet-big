---
id: redis-keyspace
layer: platform
updated: 2026-09-04
---

# Open questions — redis-keyspace

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `fx:rate:<code>` is referenced only in schema comments; no code writes it. Keep it in the catalogue as reserved? | no | ASSUMED(2026-09-04): reserved for the future `currency` service | -> currency unit |
| 2026-09-04 | The prefix is duplicated in TS and Go with only a comment keeping them in sync. Worth a shared generated constant or a test? | no | ASSUMED(2026-09-04): a cross-language test asserts the prefix later | -> operations / CI |
| 2026-09-04 | Bumping `REDIS_KEYSPACE_VERSION` logs everyone out. Is there a runbook for doing it deliberately (and for a rollback)? | no | ASSUMED(2026-09-04): documented in operations when first needed | -> operations/runbook |
