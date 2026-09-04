---
id: i18n
layer: platform
status: active
version: 1
source:
  - i18n-platform/**
  - locales/**
owns_tables: []
depends_on: []
updated: 2026-09-04
---

# i18n

**Responsibility (one sentence):** translations as a capability — `locale-service`
(Go gRPC, the single runtime reader of `locales/`), one shared Go client, one
shared Node client, and the `locales/` content tree.
**Explicitly NOT responsible for:** which language a user prefers
(`identity` / `panel-web`), business copy decisions.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | calling locale-service or changing the proto / clients |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from existing i18n-platform during onboarding |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
