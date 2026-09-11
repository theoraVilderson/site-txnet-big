---
id: i18n
layer: platform
status: active
version: 1
keywords: [i18n, locale, translation, locale-service]
source:
  - i18n-platform/**
  - locales/**
  - txnet-backend/shared-core/src/lib/i18n/**
  - site-pwa/src/generated/i18n-keys.ts
  - auth-handler/internal/i18nkeys/**
owns_tables: []
depends_on: []
updated: 2026-09-11
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
| 2026-09-11 | Typed key constants are generated from `locales/` on disk, committed, and gated by CI (`make -C i18n-platform i18n-keys`). The generators existed and were wired to nothing. spec: F-080 |
| 2026-09-04 | Documented from existing i18n-platform during onboarding |
| 2026-09-05 | `locales/backend/langs/{en,fa}/errors.json`: added `auth.alreadyAuthenticated`, the message `auth-api`'s `NoActiveSessionGuard` returns with 409. Content only — no proto, client or contract change. |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
