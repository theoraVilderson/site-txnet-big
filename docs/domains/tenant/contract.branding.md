---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-09-18
---

# Contract — tenant / branding

A topic file of `contract.md` (§10). A reseller's own brand (F-018-h, catalog
13.8, D-42 (3)). Code: `txnet-backend/tenant-service/src/app/branding/`. Theme
tokens (13.7) and per-domain SEO (`robots.txt`, sitemap, canonical) are other
rows. Rendering it: the panel is F-066-v, the landing site F-040.

## The routes

| Route | Who | Answer |
|---|---|---|
| `GET /api/tenants/:id/branding` | the reseller's owner, or platform staff with `tenant.manage` | the branding view |
| `PUT /api/tenants/:id/branding` | same, `staffWrite` | the text, **whole**: a field left out is cleared; the images are untouched |
| `PUT /api/tenants/:id/branding/assets/:slot` | same | multipart, one field `file`; stores the image and points the slot at it |
| `DELETE /api/tenants/:id/branding/assets/:slot` | same | clears the slot, then deletes the file; repeats safely |
| `GET /api/branding` | public, no `my-auth` (Traefik `tenant-branding`, priority 130) | the branding of the tenant whose Host asked |

Slots: `logo-light`, `logo-dark`, `favicon`, `og-image`. The body of the text
`PUT`: `brandName` (required, 1-64), `primaryColorHex`, `secondaryColorHex`,
`supportEmail`, `supportPhone`, `supportUrl`, `socials` (`{telegram, instagram,
whatsapp, bale, eitaa, rubika, x, youtube, linkedin}`, each optional),
`aboutText`, `termsUrl`, `privacyUrl`, `defaultLanguage` (`fa` default).

The view: the same fields plus `logoLightUrl`, `logoDarkUrl`, `faviconUrl`,
`ogImageUrl` and `updatedAt`. A reseller with no row reads as its slug for
`brandName` and nothing else set.

**Who** is `ResellerAccess` (F-061-h, invariant 21), as for domains: a suspended
reseller's owner reads but cannot write; platform staff can. Refusals:
`not_allowed` 403, `reseller_suspended` 403, `reseller_not_found` 404 (staff
only), `reseller_terminated` 409, `too_large` 413, `type_not_allowed` /
`type_mismatch` 415, `file_missing` 400; a body the schema refuses is 400.

## Rules

| Rule | Why |
|---|---|
| 1. The row stores **keys** (`tenants/<tenantId>/branding/<slot>`), never URLs; a CHECK per column holds each key to the row's own tenant and its own slot | domains rotate (object-storage rule 2); no row can point at another reseller's logo |
| 2. A URL is built on every read: `https://<host>/api/files/<key>` on the tenant's proven `assets` door, else its proven `panel` door — custom domain first, never a CNAME target, and for a reseller never any platform subdomain (`panelHostOf`, F-018-aj: it serves nothing, ADR-0063); none is a `null` URL, not a 404 | the file route serves exactly those doors, so every URL handed out is one it answers |
| 3. **Every string is data to the renderer, which escapes it** (catalog 13.8). The schema is a second wall, not the first: links are `https` only, colours `#rrggbb` (CHECK too), text has no control or bidi-override characters, and no field outside the schema is accepted | a `javascript:` link or a `</title>` in a brand name reaches every visitor of the reseller's pages |
| 4. An image is PNG or WebP — never SVG, and not JPEG (a logo needs transparency) — sniffed by the port. Caps: logos 512 KB, favicon 128 KB, OG image 1 MB; the multipart parser is capped at the largest | an SVG runs script; a type is served as stored |
| 5. Bytes are written in the **reseller's** scope (`runWithTenant`), then the key; a clear removes the key, then the bytes | the object-storage port's own order: an orphan file, never a key with no file |
| 6. `GET /api/branding` resolves its tenant with `FileHostMiddleware` — the file route's doors (`panel`, `assets`; a subdomain or a verified custom domain). Any other Host is the neutral 404 | a host never answers with another tenant's brand, nor says which tenants exist |

A replaced image keeps its key, so a browser may show the old one for up to
five minutes (`Cache-Control: max-age=300` on the file route).

## Consumers

| unit | uses |
|---|---|
| panel-web | `GET /api/branding` server-side, by the visitor's host (F-066-v, `interfaces/panel-web/contract.branding.md`) |
| marketing-web | `GET /api/branding` (F-040, not yet built) |
