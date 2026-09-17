---
id: notification
layer: domain
status: active
updated: 2026-09-17
---

# Open questions — notification

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Delivery adapters (SMS, Telegram/Bale bot, web push) don't exist. Reuse `identity` OTP senders, or a new delivery unit? | no | **CLOSED 2026-09-10 (D-10) / 2026-09-17 (F-035-e):** each channel in the unit that owns it; Telegram/Bale send from `notification-service` through `messenger` (ADR-0054) | — |
| 2026-09-04 | `filterCriteria` JSON is an unbounded query language. Who validates/executes it safely against `identity`/`billing`? | no | **CLOSED 2026-09-17 (F-035-c):** a strict zod schema is the only writer (`campaign-admin.schema.ts`, `contract.md` "Campaigns"); the fan-out translates those keys alone (F-035-d) | — |
