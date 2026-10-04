---
id: guide
layer: domain
updated: 2026-10-04
---

# Data model — guide

Built (F-414-a, ADR-0115; migration `20261004000300_guide_storage`; blocks F-414-g, ADR-0116, `20261004000400_guide_blocks`). Schema `guide`, RLS shared-read as support's categories.

| Table | Holds |
|---|---|
| guide | `id`, `tenantId` (NULL = the platform's), `key`, `kind` (`product`/`os`/`app`/`section`), `sortOrder`, `isActive`, timestamps |
| guide_translation | `guideId`, `lang`, `title`, `blocks` (JSONB, typed blocks — below); one per language |
| guide_placement | `guideId`, `surface` (`panel`/`bot`/`any`), `targetKind` (`route`/`bot_screen`/`product`/`os`/`app`), `targetRef` |
| guide_hidden | `tenantId`, `key` — a reseller hiding an inherited guide without replacing it |

`key` is `^[a-z0-9_]{1,60}$` and unique per owner (`tenantId`, NULL counted as one owner); a title is 1–120 characters; `blocks` is a JSON array of 1–100 blocks, at most 64 KiB; a placement is unique per (guide, surface, targetKind, targetRef). No database default on ids — the client mints them.

## Blocks (F-414-g, ADR-0116 point 1)

One schema, `guideBlocksSchema` in `shared-core/src/lib/guide/guide-blocks.ts`; the database holds only the array's shape and size. Every writer parses through it.

| `type` | Fields |
|---|---|
| `text` | `text` — Markdown, ≤ 20000 |
| `image` | `file` (object key), `alt` ≤ 200, `caption?` ≤ 300 |
| `video` | `file`, `poster` (object keys), `caption?` — served by the store with Range (F-414-i) |
| `steps` | `items`: 1–30 of `{ text` (Markdown ≤ 2000)`, image? }` |
| `callout` | `tone` (`info`/`tip`/`warning`/`danger`), `title?` ≤ 120, `text` ≤ 4000 |

A file is an object-storage key (`tenants/<id>/guides/…`), never a URL; `guideFileKeys(blocks)` lists them. Unknown types and fields are refused.
