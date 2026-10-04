# ADR-0116 — A guide's text is typed blocks, placed only in registered slots; video is a stored file

- Status: accepted (user, 2026-10-04)
- Feature: F-414 (rows F-414-g, F-414-h, F-414-i)

## Context

F-414-a stored a guide's text as one Markdown `body` and a placement as a free
`targetKind` + `targetRef`. The user asked for three things before any route
reads either: guides built from blocks (text, image, video, steps, callout),
video stored and streamed with Range requests and a poster, and one central
list of the slots a guide may be placed in. No row and no route existed yet,
so each change was a column, not a data migration.

## Decision

1. **A text is an ordered array of typed blocks** (`guide_translation.blocks`,
   JSONB) in place of `body`. The block types are one `as const` tuple in
   `shared-core/src/lib/guide/guide-blocks.ts` and a zod schema derived from it
   (C-09): `text` (Markdown), `image`, `video`, `steps`, `callout`. The panel
   and the bot render each type their own way; Markdown stays only inside a
   block. A file is named by its object-storage key, never a URL (object-storage
   rule 2), and only under a `guides/` path.
2. **Slots are a registry in code**, `shared-core/src/lib/guide/guide-slots.ts`:
   per `targetKind`, the surfaces it may show on and either a closed list of
   refs (panel sections, bot screens, operating systems) or a ref shape whose
   existence the writer checks (products, apps). The writer (F-414-c) refuses a
   placement the registry does not hold; the database holds what it can hold
   alone — the ref's shape and which surface a kind fits. A panel section is
   named, never a URL, so a route move does not orphan a guide.
3. **Video is a file on object storage, served by it, never through a Nest
   route** (F-414-i). Range requests are the store's (or a CDN's) job; the
   resolver returns the video's and the poster's keys and the caller builds the
   public URL. Streaming bytes through `tenant-service` was rejected: every
   viewer would hold a long connection on the service that serves every
   tenant's public pages.

## Consequences

- Adding a block type or a slot is a code change in one file, reviewed; a
  reseller cannot invent one.
- The `local` object-storage driver's serving route must answer Range for F-414-i
  to stream on dev; an S3 driver does so natively.
