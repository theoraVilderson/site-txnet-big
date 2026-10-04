# ADR-0117 — A guide is edited as a draft, read by generation, and the platform's guide files are served on every Host

- Status: accepted (user, 2026-10-04)
- Feature: F-414 (rows F-414-b, F-414-c, F-414-d)

## Context

Before the first route read or wrote a guide, the user asked for three things
that the storage of ADR-0115/0116 did not hold: edit, preview, publish and
archive; a reading route with a language fallback, a cache and an ETag; and
media on the platform's object storage that survives the move from the `local`
driver to S3. Each is expensive to change once readers cache and resellers
override.

## Decision

1. **A draft is a separate table; readers see only the published text.**
   `guide_translation` is the published text, the only one the reader serves.
   `guide_draft` (same shape: guide, language, title, blocks) holds the edits
   in progress. Editing writes the draft, copying every published language on
   first edit; **preview** renders the draft; **publish** replaces every
   published language with the draft and deletes the draft; **discard** deletes
   it. Archive is `isActive = false` (no new state column): the state shown is
   derived — `archived`, else `published` when a published text exists, else
   `draft`. Placements are not drafted: they are live, and a guide with no
   published text shows nowhere. A reseller's **override** of a platform guide
   is created as a draft holding the platform's text, so its users keep the
   platform's guide until the reseller publishes.
2. **The platform's guide files are served on every tenant's Host.** A guide
   file is a public object under `guides/` of its owner — the platform's under
   the platform tenant's prefix. The file route serves a Host's own keys and,
   from one closed list in code, the platform's `guides/` prefix — nothing else
   of the platform's (not its branding, never a private file). A reseller's
   users therefore see an inherited guide's images on the reseller's own domain:
   the white label holds and a blocked platform domain does not break them. A
   block may name only the writer's own `guides/` keys or the platform's.
3. **Read by generation.** Each owner (the platform; each tenant) has a random
   token in Redis that every write of its guides replaces. A read's ETag hashes
   the tenant, the request and both tokens, so it is known before any query: a
   matching `If-None-Match` is a 304 with no query, and the body is cached under
   it with a TTL. A platform write reaches every reseller at once; no key is
   scanned or deleted. Redis down costs the cache, never the answer.

## Consequences

- One more table (`guide_draft`), RLS shared-read like the other four.
- Moving to S3 changes nothing here: files are keys (object-storage rule 2);
  the shared prefix is the file route's rule, and a CDN in front of it keeps
  it by serving the same paths.
- A sub-reseller (F-312) adds its parent's token to the ETag's hash and its
  parent's `guides/` prefix to the shared list — no new model.
- Rejected: a status column with drafts edited in place (an edit would reach
  users before publish); a revisions table (history nobody asked for);
  copying platform images into each reseller (an update would reach no one);
  serving them from the platform's domain (breaks the white label).
