---
id: object-storage
layer: platform
status: active
version: 3
updated: 2026-09-19
---

# Contract — object-storage

The shape decided by D-42 (3), built by F-018-m. First consumer: F-018-h.

## TL;DR

One port in `shared-core` (`lib/object-storage/`). A driver is chosen by
environment: `local` (a mounted volume) now, S3-compatible later. Callers hold a
**key**, never a path or a URL, so changing the driver moves bytes and changes
no row. One public route serves a key to the tenant whose Host asked.

## Provides

| Operation | Input | Output | Errors |
|---|---|---|---|
| `ObjectStorage.put(policy, path, bytes, contentType)` | tenant (from scope), logical path, bytes, declared type | `{ key, sha256, size }`; the file and its `stored_object` row, replacing any at that key | `ObjectRejected` (`bad_path`, `type_not_allowed`, `type_mismatch`, `too_large`); an empty policy throws |
| `ObjectStorage.stat(key)` | key | the row, or `null` | `TenantScopeConflict` for another tenant's key |
| `ObjectStorage.get(key)` | key | the row + bytes | `ObjectNotFound`; `TenantScopeConflict` |
| `ObjectStorage.delete(key)` | key | — | `ObjectNotFound`; `TenantScopeConflict` |
| `GET /api/public/tenant/files/<key>` (tenant-service; `/api/files/<key>` **@deprecated since 2026-09-19**, remove after the next release) | the Host, the key | the file | a neutral 404 for everything else |
| `objectKey` / `parseObjectKey` | tenant id + path / key | key / `{ tenantId, path }` or `null` | — |
| `objectDriverFromEnv(env)` | `OBJECT_STORAGE_DRIVER`, `OBJECT_STORAGE_LOCAL_ROOT` | the driver | an unbuilt driver or no root throws at boot |

Every operation needs a tenant in scope (`TenantContextMissing` otherwise).
Another tenant's key is a **conflict**, not a miss: the caller named something it
does not own, which is a bug to surface.

## Rules

1. A key is `tenants/<tenantId>/<logical path>` — the same string is a path on
   the local volume and an object key in a bucket. A logical path is lower-case
   segments starting with a letter or digit (`[a-z0-9][a-z0-9._-]*`), at most
   200 characters, so `.`, `..`, an empty segment and a leading `/` cannot be
   spelled. `stored_object_key_prefix` (a CHECK) holds the key's tenant equal to
   the row's.
2. The database stores keys only. A public URL is built at render time from the
   tenant's current `assets` or `panel` domain, because domains rotate (F-102,
   F-105).
3. Every file has a `stored_object` row: key, tenantId, contentType, size,
   sha256 — a migration to S3 is verified against it. `put` writes bytes then
   row; `delete` removes row then bytes — a stray file is an orphan the next
   `put` overwrites, never a row pointing at nothing.
4. A caller's allowed types and size are declared per use, never defaulted.
   A type is allowed only if its bytes can be checked (`SNIFFABLE_TYPES`: PNG,
   WebP, JPEG) and `put` checks them: an HTML page declared a PNG is
   `type_mismatch`. SVG has no signature, so no policy can name it (catalog
   13.8).
5. **The `local` driver needs one node or a shared volume.** Replicas on
   separate disks each hold a different subset of the files. Writes are a
   temporary file renamed into place, so a reader never sees half a file.
6. `storedObject` is in `TENANT_SCOPED_MODELS` and the table has strict RLS: on
   the app pool every query is filtered to, and bound to, the tenant in scope.

## The serving route

`GET /api/public/tenant/files/<key>` on `tenant-service` — public, because an
`<img>` carries no session (ADR-0065: Traefik router `tenant-public`, no `my-auth`).

- `PublicHostMiddleware` resolves the Host with `surfaceOfHost` (`shared-core`)
  and `@PublicRoute({ doors: ['panel', 'assets'] })` holds the route to `panel`
  and `assets` rows: a subdomain, or a **verified** custom domain, never a
  closed door (ADR-0063). That tenant is the scope.
- A key outside that tenant's prefix, a key with no row, a row with no bytes,
  an unknown Host and an unproven domain are **one neutral 404** — a reseller's
  domain never says that another reseller's file exists.
- `TenantStatusGuard` judges it as a `read`: a terminated tenant's files stop
  being served, a suspended one's follow its grace.
- Headers: the stored `Content-Type`, `ETag: "<sha256>"` (a match is a 304),
  `Cache-Control: public, max-age=300`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`. A replaced file keeps
  its key, so browsers can show the old one for up to five minutes.

## Configuration

| variable | meaning |
|---|---|
| `OBJECT_STORAGE_DRIVER` | `local` (the only one built) |
| `OBJECT_STORAGE_LOCAL_ROOT` | the volume; `/data/objects`, mounted from `object_storage` in compose |

Moving to S3: copy each file by key, check it against `sha256`, switch the
driver. No row changes.

## Not done here

- No private files: everything served is public by Host. Ticket attachments
  (`support`) need an owner check and a column saying so, as their own row.
- No upload route of its own: a consumer receives the bytes and calls `put`
  (tenant's branding, F-018-h).
- No rate limit on the file route; the ETag keeps repeat views to a 304.

## Consumers

| unit | uses |
|---|---|
| tenant | branding images, `put` in the reseller's scope at `branding/<slot>` (F-018-h, [contract.branding.md](../../domains/tenant/contract.branding.md)) |
| support | ticket attachments (not yet in the backlog) |
