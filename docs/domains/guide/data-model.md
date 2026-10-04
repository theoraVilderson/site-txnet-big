---
id: guide
layer: domain
updated: 2026-10-04
---

# Data model — guide

Built (F-414-a, ADR-0115; migration `20261004000300_guide_storage`; blocks F-414-g, ADR-0116, `20261004000400_guide_blocks`; slots F-414-h, `20261004000500_guide_slots`; drafts F-414-c, ADR-0117, `20261004000600_guide_draft`). Schema `guide`, RLS shared-read as support's categories.

| Table | Holds |
|---|---|
| guide | `id`, `tenantId` (NULL = the platform's), `key`, `kind` (`product`/`os`/`app`/`section`), `sortOrder`, `isActive` (false = archived), `publishedAt`, timestamps |
| guide_translation | `guideId`, `lang`, `title`, `blocks` (JSONB, typed blocks — below); one per language — the **published** text, the only one readers get |
| guide_draft | the same shape plus `updatedAt`: the text being edited; publish copies it over `guide_translation` and deletes it (ADR-0117 point 1) |
| guide_placement | `guideId`, `surface` (`panel`/`bot`/`any`), `targetKind` (`route`/`bot_screen`/`product`/`os`/`app`), `targetRef` |
| guide_hidden | `tenantId`, `key` — a reseller hiding an inherited guide without replacing it |

`key` is `^[a-z0-9_]{1,60}$` and unique per owner (`tenantId`, NULL counted as one owner); a title is 1–120 characters; `blocks` is a JSON array of 1–100 blocks, at most 64 KiB; a placement is unique per (guide, surface, targetKind, targetRef), its `targetRef` a slug or lower-case UUID (`^[a-z0-9][a-z0-9_-]{0,63}$`), and a `route` shows only on `panel`, a `bot_screen` only on `bot`. No database default on ids — the client mints them.

## Blocks (F-414-g, ADR-0116 point 1)

One schema, `guideBlocksSchema` in `shared-core/src/lib/guide/guide-blocks.ts`; the database holds only the array's shape and size. Every writer parses through it.

| `type` | Fields |
|---|---|
| `text` | `text` — Markdown, ≤ 20000 |
| `image` | `file` (object key), `alt` ≤ 200, `caption?` ≤ 300 |
| `video` | `file` (MP4/WebM), `poster` (an image; object keys), `caption?` — the file served by the media server with Range (F-414-i, ADR-0118) |
| `steps` | `items`: 1–30 of `{ text` (Markdown ≤ 2000)`, image? }` |
| `callout` | `tone` (`info`/`tip`/`warning`/`danger`), `title?` ≤ 120, `text` ≤ 4000 |

A file is an object-storage key (`tenants/<id>/guides/…`), never a URL; `guideFileKeys(blocks)` lists them. Unknown types and fields are refused.

## Slots (F-414-h, ADR-0116 point 2)

`GUIDE_SLOTS` in `shared-core/src/lib/guide/guide-slots.ts` is the registry; `guideSlotRefusal(placement)` says why one is not a slot (`bad_ref`, `surface`, `unknown_ref`) and every writer calls it.

| `targetKind` | surfaces | refs |
|---|---|---|
| `route` | `panel` | `GUIDE_PANEL_SECTIONS` — a section's name, never its URL |
| `bot_screen` | `bot` | `GUIDE_BOT_SCREENS` |
| `os` | any | `GUIDE_OSES` |
| `product` | any | open: a catalog product id, existence checked by the writer |
| `app` | any | open: a client app's slug |
