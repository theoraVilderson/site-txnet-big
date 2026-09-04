---
id: governance
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — governance

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Access checks combine base role + temporal grants + restrictions. Where does that resolver live — `identity` token minting, or a per-request check in each service? | yes | ASSUMED(2026-09-04): a shared guard reads grants/restrictions per request | -> ADR |
| 2026-09-04 | `user_setting.key` namespace (e.g. `notify.telegram.low_balance`) is free text. Registry of valid keys? | no | ASSUMED(2026-09-04): keys are constants owned by the feature that reads them | -> rules.md |
