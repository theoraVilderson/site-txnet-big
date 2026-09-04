---
id: governance
layer: domain
status: draft
version: 1
keywords: [settings, access grant, restriction, cap]
source: []
owns_tables: [user_setting, temporal_access_grant, user_restriction]
depends_on: [identity]
updated: 2026-09-04
---

# Governance

**Responsibility (one sentence):** per-user key/value settings, time-boxed extra access grants (beyond the base role), and admin-imposed usage/spend caps on a user.
**Explicitly NOT responsible for:** tenant-level caps (`tenant`), the base RBAC role model (`identity`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing governance from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
