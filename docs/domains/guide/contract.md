---
id: guide
layer: domain
status: active
version: 2
updated: 2026-10-04
---

# Contract — guide

Storage built (F-414-a, [data-model.md](data-model.md)); reading built (F-414-b); the admin routes are intent (§0 level 4), F-414-c. Shape: ADR-0115, ADR-0116, ADR-0117.

## TL;DR

A guide has a stable `key`, a kind (`product`, `os`, `app`, `section`), a text
per language (typed blocks, ADR-0116 — [data-model.md](data-model.md)) and one or more placements, each in a registered slot (data-model.md "Slots"). The platform's (`tenantId` NULL) are
every reseller's; a reseller's own guide with the same key replaces it, a hide
row removes it. Resolution is "nearest owner wins" over the tenant's ancestry.

## Provides

| Route (tenant-service) | Who | Output |
|---|---|---|
| `GET /api/public/tenant/guides?placement=<targetKind>:<targetRef>&surface=panel\|bot` | anyone on the tenant's **panel** Host (`@PublicRoute({ doors: ['panel'] })`) | `{ guides: ResolvedGuide[] }` — the guides placed in that slot (a placement on `any` matches both surfaces; `surface` defaults to `panel`), by `sortOrder` then `key` (F-414-b) |
| `GET /api/public/tenant/guides/:key` | as above | `{ guide: ResolvedGuide }`; a 404 when the tenant sees none |
| `…/guides/settings/*` (planned) | `guide.manage` | own and inherited, override, hide/restore, texts, placements, draft, preview, publish, archive (F-414-c) |

`ResolvedGuide` is `{ key, kind, owner: 'platform'|'own', lang, title, blocks, sortOrder, updatedAt }`; `lang` is the language served. A block's files are object keys — the caller builds `/api/public/tenant/files/<key>` on the Host it is on (ADR-0116 point 3). A slot outside the registry, or a bad key, is a 400; an unknown Host the neutral 404.

### Rules of the read (F-414-b, ADR-0117)

1. **Nearest owner wins, by key.** The tenant's own *live* guide (active, with a published text) replaces the platform's of the same key wherever either is placed; a `guide_hidden` row drops the platform's. An own draft or an archived own copy replaces nothing.
2. **Only the published text** (`guide_translation`) is read; a draft never is.
3. **Language:** `Accept-Language`, else the platform's chain (`FALLBACK_LANGS`: `en` → `fa`), else any language the guide has.
4. **ETag by generation:** `RedisKeys.guideGeneration(<owner>)` holds a random token per owner (`platform` or a tenant id), replaced by every write of that owner's guides (`GuideGenerations.bump`). The ETag hashes tenant, request and both tokens; a matching `If-None-Match` is a 304 with no query. The body is cached at `RedisKeys.guideResolved(tenant, etag)` for 600 s. `Cache-Control: public, no-cache`, `Vary: Accept-Language`.
5. **Redis down:** the answer comes from the database with `Cache-Control: no-store` and no ETag.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | the caller's tenant (Host or token) and its ancestry | guides blocked |
| i18n | the language list and fallback order | the platform's default language |

## Guarantees

- A reseller never sees another reseller's guide.
- A platform edit reaches every reseller that has not replaced or hidden it.
