---
id: guide
layer: domain
status: active
updated: 2026-10-04
---

# Invariants — guide

Rows 1–2 are held by the database since F-414-a, row 5 partly since F-414-h, proved by `tenant-service/src/app/guide/guide-schema.int.spec.ts`; 3–4 by the resolver since F-414-b, proved by `tenant-service/src/app/guide/guide-reader.spec.ts`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A tenant reads the platform's guides and its own, writes only its own | RLS shared-read policy on all four tables (a write to a platform row is refused, not ignored) | a reseller edits the platform's help, or reads another's |
| 2 | One guide per key per owner | `guide_tenantId_key_key` + `guide_platform_key` (partial) | two answers for one placement |
| 3 | A tenant's live guide (active, published) with a platform key replaces it for that tenant only — a draft or archived copy does not; a hide removes it for that tenant only | `GuideReader` (F-414-b): candidates, then the tenant's live keys and hides among them, in one transaction | one reseller's change shows for every reseller |
| 4 | A guide's text is shown only in a language it has, else the fallback order | `pickTranslation` (F-414-b) | a blank help page |
| 5 | A guide is placed only in a registered slot | `guideSlotRefusal` (shared-core) in every writer; the ref's shape and a kind's surface by `guide_placement_ref`/`guide_placement_slot` | a guide no screen ever asks for, or one keyed to a URL that moved |
