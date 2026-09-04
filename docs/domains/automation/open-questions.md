---
id: automation
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — automation

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | There is no scheduler/runtime in code. `@nestjs/schedule` is a dependency — is that the intended runner, or an external cron/queue? | yes | ASSUMED(2026-09-04): `@nestjs/schedule` inside a worker process (or billing-service) | -> ADR |
| 2026-09-04 | Concurrency: can two instances run the same worker? Any lock (`bot_worker` row lock / Redis)? | yes | ASSUMED(2026-09-04): single-instance workers, Redis lock per `key` if scaled | -> rules.md |
