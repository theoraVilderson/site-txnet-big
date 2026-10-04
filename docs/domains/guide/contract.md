---
id: guide
layer: domain
status: draft
version: 1
updated: 2026-10-04
---

# Contract — guide

Storage built (F-414-a, [data-model.md](data-model.md)); the routes below are intent (§0 level 4), F-414-b … F-414-f. Shape: ADR-0115.

## TL;DR

A guide has a stable `key`, a kind (`product`, `os`, `app`, `section`), a text
per language (typed blocks, ADR-0116 — [data-model.md](data-model.md)) and one or more placements. The platform's (`tenantId` NULL) are
every reseller's; a reseller's own guide with the same key replaces it, a hide
row removes it. Resolution is "nearest owner wins" over the tenant's ancestry.

## Provides (planned)

| Route (tenant-service) | Who | Output |
|---|---|---|
| `GET /api/guides?placement=<kind>:<ref>` | anyone on the tenant's Host / a signed-in chat | the resolved guides for that placement, in `Accept-Language` (F-414-b) |
| `GET /api/guides/:key` | as above | one resolved guide |
| `…/guides/settings/*` | `guide.manage` | own and inherited, override, hide/restore, texts, placements (F-414-c) |

The exact shapes are F-414-b/c's to write here, at build time.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | the caller's tenant (Host or token) and its ancestry | guides blocked |
| i18n | the language list and fallback order | the platform's default language |

## Guarantees (planned)

- A reseller never sees another reseller's guide.
- A platform edit reaches every reseller that has not replaced or hidden it.
