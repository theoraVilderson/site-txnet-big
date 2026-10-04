---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-04
---

# Contract — panel-web: guide settings (`/guides`)

Built by F-414-d over tenant-service's `/api/guides/settings` ([guide/contract.md](../../domains/guide/contract.md), F-414-c; ADR-0117). Menu entry `guides`, `requires: ["guide.manage"]`. Code: `site-pwa/src/app/(panel)/guides/`, client `src/lib/guide-api.ts`.

## Pages

| Route | Shows |
|---|---|
| `/guides` (`PANEL_GUIDES`) | the caller's own guides (the platform's, for the platform owner's admin) with kind, state, "unpublished changes", published languages; a new-guide form (key, kind, language, title, first paragraph → a draft); for a reseller, the platform's inherited guides with **view**, **make my own version** (override → its editor) and **hide / show again** |
| `/guides/[id]` (`panelGuidePath`) | one guide: **Text** (per language: title and blocks — text, image, steps, callout — add, move, remove; image upload), **Where it shows** (placements), **Preview** (per language); actions save draft, publish, discard draft, archive / restore, delete |

## Rules

1. **Saving never reaches users; publishing does.** Save draft writes `PUT …/draft`; publish saves unsaved edits first, then `POST …/publish`. The editor opens on the draft when there is one, else the published text.
2. **The form stops what tenant-service would refuse**: `validateTexts` mirrors `guideBlocksSchema` and `guide_draft`'s bounds (title 1–120, 1–100 blocks, text ≤ 20000, image needs a file and alt, 1–30 steps, callout ≤ 4000); `textsBody` drops untouched languages and empty optional fields so the `.strict()` schema accepts the body.
3. **Slots are shared-core's.** `GUIDE_SLOTS` in `_lib/guides.ts` copies `guide-slots.ts`; `guides.test.ts` reads that file and fails when they differ. A closed kind is a picker; `app` and `product` a free slug/id. Placements save at once (no draft).
4. **Images are keys.** An upload returns `{ key }`, stored in the block; the page shows it at `/api/public/tenant/files/<key>` on its own Host (`guideFileUrl`). A video block already stored is shown, not edited (upload is F-414-i).
5. **A platform guide seen by a reseller is read-only** (`readOnly`): its published text and an override button, nothing else.
6. Every refusal reason the controller maps has a sentence (`REFUSAL_KEYS`, held to the controller's `STATUS` by the test). Text is shown as written in preview (line breaks kept); Markdown rendering for users is F-414-e's.
