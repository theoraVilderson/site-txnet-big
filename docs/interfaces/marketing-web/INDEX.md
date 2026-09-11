---
id: marketing-web
layer: interface
status: draft
version: 1
keywords: [landing site, coinsite, marketing site, apex domain, home page, صفحه اصلی, سایت اصلی, لندینگ, default language, زبان پیشفرض, سایت انگلیسی میاد]
source:
  - coinsite/src/**
owns_tables: []
depends_on: []
updated: 2026-09-10
---

# marketing-web

**Responsibility (one sentence):** the public landing site (`coinsite`) served at
the apex `<domain>` / `www.<domain>` — currently a Next.js skeleton (home page +
empty login/register scaffolds).
**Explicitly NOT responsible for:** the authenticated panel (`panel-web`), any
API.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | changing the site |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-10 | F-068: `<html lang="en">` was hardcoded while `.env` said `DEFAULT_LANGUAGE=fa`, so the apex domain greeted every visitor in the wrong language and direction. `src/env.ts` now derives `lang` + `dir` from the environment. Still a skeleton — no locale-service client, no cookie, no switcher (user decision, 2026-09-10); `source:` claimed at the same time |
| 2026-09-04 | Documented as a skeleton during onboarding |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
