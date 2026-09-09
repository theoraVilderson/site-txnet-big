---
id: billing
layer: domain
updated: 2026-09-04
---

# Open questions — billing

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `billing-service` is an empty scaffold. Does billing logic land there, or inside `auth-service`/a new service? | yes | ASSUMED(2026-09-04): it fills the existing `billing-service` app, behind ForwardAuth | -> ADR |
| 2026-09-04 | No idempotency-key column on `payment_transaction`. How is double-credit prevented across webhook + reconciliation + admin? | resolved | **Answered 2026-09-09 by ADR-0028**: `@@unique([gatewayId, gatewayTrackingCode])` plus a status guard, both inside the crediting transaction. A gateway with no stable tracking code cannot be integrated without a new decision | -> ADR-0028 + migration |
| 2026-09-04 | Who triggers provisioning (`network.config`) on payment success — synchronous call, outbox, or RabbitMQ? | resolved | **Answered 2026-09-09 by ADR-0021: a transactional outbox.** The producer writes its row and its event in one transaction; a relay delivers them. The "synchronous call until a bus exists" assumption is withdrawn | -> ADR-0021 |
| 2026-09-04 | `wallet_transfer_request.otpCodeHash` — does it reuse `identity` OTP infra or its own? | no | ASSUMED(2026-09-04): reuses `OtpService` with a transfer purpose | -> rules.md |
