---
id: governance
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — governance

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Access checks combine base role + temporal grants + restrictions. Where does that resolver live — `identity` token minting, or a per-request check in each service? | resolved | **Answered 2026-09-09 by ADR-0029**: the token keeps the base role only; grants and restrictions are read per request by a shared guard, cached in Redis with explicit invalidation. Suspension is immediate rather than up to one token TTL late | -> ADR-0029 |
| 2026-09-04 | `user_setting.key` namespace (e.g. `notify.telegram.low_balance`) is free text. Registry of valid keys? | no | ASSUMED(2026-09-04): keys are constants owned by the feature that reads them | -> rules.md |
