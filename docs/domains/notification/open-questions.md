---
id: notification
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — notification

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Delivery adapters (SMS, Telegram/Bale bot, web push) don't exist. Reuse `identity` OTP senders, or a new delivery unit? | yes | ASSUMED(2026-09-04): a `platform` delivery unit shared with OTP senders | -> ADR / new unit |
| 2026-09-04 | `filterCriteria` JSON is an unbounded query language. Who validates/executes it safely against `identity`/`billing`? | yes | ASSUMED(2026-09-04): the campaign worker translates a fixed schema to SQL | -> rules.md |
