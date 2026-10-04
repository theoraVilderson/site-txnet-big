---
id: guide
layer: domain
status: active
version: 2
updated: 2026-10-04
---

# Contract — guide

Storage built (F-414-a, [data-model.md](data-model.md)); reading built (F-414-b); the settings built (F-414-c). Shape: ADR-0115, ADR-0116, ADR-0117.

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
| `/api/guides/settings/*` | `guide.manage` (gate; tenant-service, Traefik `PathPrefix(/api/guides)`) | the settings below (F-414-c) |

`ResolvedGuide` is `{ key, kind, owner: 'platform'|'own', lang, title, blocks, sortOrder, updatedAt }`; `lang` is the language served. A block's files are object keys — the caller builds `/api/public/tenant/files/<key>` on the Host it is on (ADR-0116 point 3). A slot outside the registry, or a bad key, is a 400; an unknown Host the neutral 404.

### Rules of the read (F-414-b, ADR-0117)

1. **Nearest owner wins, by key.** The tenant's own *live* guide (active, with a published text) replaces the platform's of the same key wherever either is placed; a `guide_hidden` row drops the platform's. An own draft or an archived own copy replaces nothing.
2. **Only the published text** (`guide_translation`) is read; a draft never is.
3. **Language:** `Accept-Language`, else the platform's chain (`FALLBACK_LANGS`: `en` → `fa`), else any language the guide has.
4. **ETag by generation:** `RedisKeys.guideGeneration(<owner>)` holds a random token per owner (`platform` or a tenant id), replaced by every write of that owner's guides (`GuideGenerations.bump`). The ETag hashes tenant, request and both tokens; a matching `If-None-Match` is a 304 with no query. The body is cached at `RedisKeys.guideResolved(tenant, etag)` for 600 s. `Cache-Control: public, no-cache`, `Vary: Accept-Language`.
5. **Redis down:** the answer comes from the database with `Cache-Control: no-store` and no ETag.

## The settings (F-414-c, ADR-0117)

The caller's tenant is the owner: the platform owner's admin edits the platform's guides (`tenantId` NULL, on the cross-tenant pool); a reseller's admin its own (app pool, RLS). A guide of another owner is `guide_unknown` (404) for every act but reading a live platform guide, which a reseller gets `readOnly: true` without its draft.

| Route | Does |
|---|---|
| `GET /` | `{ owner: 'platform'\|'tenant', own: GuideSummary[], inherited: [{ id, key, kind, title, placements, overriddenBy, hidden }] }` |
| `POST /` | `{ key, kind, sortOrder?, texts, placements? }` — a new guide; texts go to the **draft** |
| `GET /:id` · `PATCH /:id` · `DELETE /:id` | detail (`published`, `draft`, `state`, `hasDraft`) · `kind`/`sortOrder` (the key never changes) · delete |
| `PUT /:id/draft` · `DELETE /:id/draft` | `{ texts }` replaces every draft language · discard (`guide_no_draft` 409 when none) |
| `GET /:id/preview?lang=` | the draft, else the published text, as a reader would get it, with `source` |
| `POST /:id/publish` | the draft replaces every published language; the draft is deleted; `publishedAt` set |
| `POST /:id/archive` · `POST /:id/restore` | `isActive` false/true |
| `PUT /:id/placements` | `{ placements }` replaces all; each a registered slot (`guide_slot` 400), a product one the owner sees (`guide_product_unknown` 400) |
| `POST /:id/files` | multipart `file`, PNG/WebP/JPEG ≤ 2 MiB, public, at `guides/<id>/<uuid>.<ext>` of the owner (the platform's tenant for the platform) → `{ key }` |
| `POST /inherited/:key/override` | a reseller's own copy: a draft of the platform's published text and its placements (`guide_key_taken` 409 if it has one) |
| `PUT` · `DELETE /inherited/:key/hidden` | hide / show again a platform guide for this reseller (204) |

Rules:

1. `state` is derived: `archived` when inactive, else `published` once a text is published, else `draft`.
2. A text names only files under its owner's `guides/` or the platform's `guides/` (served on every Host, ADR-0117 point 2), stored and public — else `guide_file` 400.
3. Publish, archive/restore, placements, kind/order, delete, hide/show bump the owner's generation; a draft write does not, as no reader sees it.
4. No file is deleted by these routes — an override keeps naming the platform's files.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | the caller's tenant (Host or token) and its ancestry | guides blocked |
| i18n | the language list and fallback order | the platform's default language |

## Guarantees

- A reseller never sees another reseller's guide.
- A platform edit reaches every reseller that has not replaced or hidden it.
