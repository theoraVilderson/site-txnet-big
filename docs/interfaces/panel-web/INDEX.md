---
id: panel-web
layer: interface
status: active
version: 1
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n]
updated: 2026-09-04
---

# panel-web

**Responsibility (one sentence):** the Next.js user panel (`site-pwa`) served at
`panel.<domain>` — auth screens (login / signup / OTP / forgot-password),
locale + theme handling, and a thin server-side proxy to the backend API.
**Explicitly NOT responsible for:** any business rule, auth decisions (delegated
to `auth-api`), translation content (`i18n`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | changing routes / the API proxy / i18n endpoints |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from existing site-pwa during onboarding |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
