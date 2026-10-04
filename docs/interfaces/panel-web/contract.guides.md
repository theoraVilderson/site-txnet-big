---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-04
---

# Contract — panel-web: guide settings (`/guides`)

Settings built by F-414-d over tenant-service's `/api/guides/settings`; guides shown to users by F-414-e over the public read ("Where users read them") ([guide/contract.md](../../domains/guide/contract.md), F-414-c; ADR-0117). Menu entry `guides`, `requires: ["guide.manage"]`. Code: `site-pwa/src/app/(panel)/guides/`, client `src/lib/guide-api.ts`.

## Pages

| Route | Shows |
|---|---|
| `/guides` (`PANEL_GUIDES`) | the caller's own guides (the platform's, for the platform owner's admin) with kind, state, "unpublished changes", published languages; a new-guide form (key, kind, language, title, first paragraph → a draft); for a reseller, the platform's inherited guides with **view**, **make my own version** (override → its editor) and **hide / show again** |
| `/guides/[id]` (`panelGuidePath`) | one guide: **Text** (per language: title and blocks — text, image, video, steps, callout — add, move, remove; image upload), **Where it shows** (placements), **Preview** (per language); actions save draft, publish, discard draft, archive / restore, delete |

## Rules

1. **Saving never reaches users; publishing does.** Save draft writes `PUT …/draft`; publish saves unsaved edits first, then `POST …/publish`. The editor opens on the draft when there is one, else the published text.
2. **The form stops what tenant-service would refuse**: `validateTexts` mirrors `guideBlocksSchema` and `guide_draft`'s bounds (title 1–120, 1–100 blocks, text ≤ 20000, image needs a file and alt, 1–30 steps, callout ≤ 4000); `textsBody` drops untouched languages and empty optional fields so the `.strict()` schema accepts the body.
3. **Slots are shared-core's.** `GUIDE_SLOTS` in `_lib/guides.ts` copies `guide-slots.ts`; `guides.test.ts` reads that file and fails when they differ. A closed kind is a picker; `app` and `product` a free slug/id. Placements save at once (no draft).
4. **Files are keys.** An upload returns `{ key }`, stored in the block; the page shows an image at `/api/public/tenant/files/<key>` on its own Host (`guideFileUrl`) and plays a video from `/api/public/media/<key>` (`guideVideoUrl`, the media server — ADR-0118). A video block takes an MP4/WebM (`uploadVideo`, ≤ 50 MiB) and a cover image; `validateTexts` asks for both (F-414-i).
5. **A platform guide seen by a reseller is read-only** (`readOnly`): its published text and an override button, nothing else.
6a. **Numbers on `/guides`** (F-414-l, ADR-0119): a period picker (7 / 30 / 90 days, 30 first) over `GET …/stats`; each own and inherited row shows its views (panel / bot split in the tooltip) and current 👍/👎 votes, "no views yet" for none. A reseller's are its own users'; the platform owner's are every reseller's for platform guides — the line under the picker says which. A failed read costs the numbers, never the list.
6. Every refusal reason the controller maps has a sentence (`REFUSAL_KEYS`, held to the controller's `STATUS` by the test). Preview and the read-only view render through the users' `GuideBlocks`, so an admin sees what users get.

## Where users read them (F-414-e)

Over `GET /api/public/tenant/guides?placement=…&surface=panel` (`guideReadApi`, no credential; the browser revalidates by ETag). Code: `src/app/(panel)/_components/guide/`, `_lib/guide-help.ts`, `_lib/guide-markdown.ts`.

| Surface | Slot | Shows |
|---|---|---|
| top bar **Help** (`HelpButton`, before the switcher, shell rule 5) | `route:<section>` of the current path | the section's guides in a sheet: one whole, several as titles opening each; above them a search box (F-414-j, `GuideSearch.tsx`) over `guide-search` — 2+ characters, sent once typing rests 300 ms, hits with a snippet, each opening its guide by key |
| My services, **How to connect** under the subscription link (`ConnectGuide`) | `os:<os>` | a system picker opening on the browser's own (`osFromUserAgent`, else Android); the system's guides are its app choice |

7. **The path names the section, the registry the name.** `GUIDE_SECTION_ROUTES` maps every shared-core section to its route constant (C-10); `sectionOfPath` takes the longest whole-segment match, `home` else. `guide-help.test.ts` reads `guide-slots.ts` and fails on a section with no route.
8. **Nothing is read until opened**, and an answer is shown only under the slot it was asked for.
9. **Markdown is data, never HTML.** `parseGuideMarkdown` reads headings, lists, strong/em, code and links into nodes `GuideBlocks` builds as elements; a tag stays text; a link is only `http(s)://` (new tab, `noopener nofollow`) or an own `/path` — anything else stays text.
11. **Under every guide shown whole** — Help sheet, search, support's offer (`GuideFeedback.tsx`, F-414-l): the view is reported (`POST …/guides/:key/view`, nothing shown either way), and a signed-in user is asked "was this helpful?" — yes / no, the current vote pressed, changeable (`/api/guides/feedback/:key`). A visitor whose own vote cannot be read sees no question rather than a button that fails.
10. **The existing state-driven guides stay UI copy** (systems F-027-ck, catalog wizard F-026-g): they tick by the page's own state, which a stored text cannot (`guide/open-questions.md`, closed 2026-10-04).
