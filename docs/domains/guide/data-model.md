---
id: guide
layer: domain
updated: 2026-10-04
---

# Data model — guide

Built (F-414-a, ADR-0115; migration `20261004000300_guide_storage`). Schema `guide`, RLS shared-read as support's categories.

| Table | Holds |
|---|---|
| guide | `id`, `tenantId` (NULL = the platform's), `key`, `kind` (`product`/`os`/`app`/`section`), `sortOrder`, `isActive`, timestamps |
| guide_translation | `guideId`, `lang`, `title`, `body` (Markdown); one per language |
| guide_placement | `guideId`, `surface` (`panel`/`bot`/`any`), `targetKind` (`route`/`bot_screen`/`product`/`os`/`app`), `targetRef` |
| guide_hidden | `tenantId`, `key` — a reseller hiding an inherited guide without replacing it |

`key` is `^[a-z0-9_]{1,60}$` and unique per owner (`tenantId`, NULL counted as one owner); a title is 1–120 characters, a body 1–20000; a placement is unique per (guide, surface, targetKind, targetRef). No database default on ids — the client mints them.
