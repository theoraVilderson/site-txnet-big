---
id: billing
layer: domain
updated: 2026-09-04
---

# Open questions — billing

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `billing-service` is an empty scaffold. Does billing logic land there, or inside `auth-service`/a new service? | yes | ASSUMED(2026-09-04): it fills the existing `billing-service` app, behind ForwardAuth | -> ADR |
| 2026-09-04 | No idempotency-key column on `payment_transaction`. How is double-credit prevented across webhook + reconciliation + admin? | yes (money) | ASSUMED(2026-09-04): unique gateway tracking code + status guard in one tx | -> data-model.md + migration |
| 2026-09-04 | Who triggers provisioning (`network.config`) on payment success — synchronous call, outbox, or RabbitMQ? | yes | ASSUMED(2026-09-04): synchronous service call until a bus exists | -> ADR (event transport) |
| 2026-09-04 | `wallet_transfer_request.otpCodeHash` — does it reuse `identity` OTP infra or its own? | no | ASSUMED(2026-09-04): reuses `OtpService` with a transfer purpose | -> rules.md |
