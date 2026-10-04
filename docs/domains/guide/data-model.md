---
id: guide
layer: domain
updated: 2026-10-04
---

# Data model — guide

**Planned** (F-414-a, ADR-0115). Schema `guide`, RLS shared-read as catalog's.

| Table | Holds |
|---|---|
| guide | `id`, `tenantId` (NULL = the platform's), `key`, `kind` (`product`/`os`/`app`/`section`), `sortOrder`, `isActive`, timestamps |
| guide_translation | `guideId`, `lang`, `title`, `body` (Markdown); one per language |
| guide_placement | `guideId`, `surface` (`panel`/`bot`/`any`), `targetKind` (`route`/`bot_screen`/`product`/`os`/`app`), `targetRef` |
| guide_hidden | `tenantId`, `key` — a reseller hiding an inherited guide without replacing it |

`key` is unique per owner (`tenantId`, NULL counted as one owner).
