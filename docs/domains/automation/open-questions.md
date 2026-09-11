---
id: automation
layer: domain
status: draft
updated: 2026-09-10
---

# Open questions — automation

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | There is no scheduler/runtime in code. `@nestjs/schedule` is a dependency — is that the intended runner, or an external cron/queue? | resolved | **Answered 2026-09-09 by ADR-0027: RabbitMQ consumers in a worker process**, separate from anything serving requests. A schedule is a message; `@nestjs/schedule` may drive the timer inside that worker but runs no business work in `auth-service` | -> ADR-0027 |
| 2026-09-04 | Concurrency: can two instances run the same worker? Any lock (`bot_worker` row lock / Redis)? | resolved | **Answered 2026-09-09 by ADR-0027**: delivery is at-least-once, so a worker must be safe to run twice. A job that genuinely must not run twice carries its own guard; the queue provides none | -> ADR-0027 |
| 2026-09-09 | Catalog block 10.1 listed `webhookSecret` as a column on `BotIntegration`; ADR-0026 rule 1 says a tenant-owned secret lives in the vault and nowhere else. | resolved | **Answered 2026-09-09 (user): the code is right and the catalog line was corrected.** The secret is a vault row under the same `credentialRef` label, with the rotation grace window `verify` honours — no column | -> catalog 10.1, corrected |
| 2026-09-10 | What the per-tenant run cap does when Redis, its shared counter since F-067-e, cannot be reached: refuse (defer, then dead-letter) or degrade to the per-process count? | no | `ASSUMED(2026-09-10)`: **degrade.** The fallback is F-066-p's cap — weaker than the shared one, much stronger than none, and what the platform ran on until today. Refusing would defer every tenant tick and dead-letter it after `MAX_DEFERRALS`, turning a fairness control into an outage for exactly the tenants it protects | -> a rule in `contract.tenant-cap.md` once a tenant-scoped tick actually exists and the degraded mode has been seen once. Nothing publishes one yet, so the choice has never been exercised |
