---
id: object-storage
layer: platform
status: active
version: 5
updated: 2026-10-22
---

# Contract — object-storage

The shape decided by D-42 (3), built by F-018-m. First consumer: F-018-h.

## TL;DR

One port in `shared-core` (`lib/object-storage/`). A driver is chosen by
environment: `local` (a mounted volume) or `s3` (any S3-compatible bucket,
F-018-m2-a). Callers hold a
**key**, never a path or a URL, so changing the driver moves bytes and changes
no row. One public route serves a public key to the tenant whose Host asked;
a private key is served only through a 5-minute signed URL (ADR-0113).

## Provides

| Operation | Input | Output | Errors |
|---|---|---|---|
| `ObjectStorage.put(policy, path, bytes, contentType)` | tenant (from scope), logical path, bytes, declared type; the policy's `visibility` (`public`/`private`) is recorded as `private` | `{ key, sha256, size }`; the file and its `stored_object` row, replacing any at that key | `ObjectRejected` (`bad_path`, `type_not_allowed`, `type_mismatch`, `too_large`); an empty policy throws |
| `ObjectStorage.stat(key)` | key | the row, or `null` | `TenantScopeConflict` for another tenant's key |
| `ObjectStorage.get(key)` | key | the row + bytes | `ObjectNotFound`; `TenantScopeConflict` |
| `ObjectStorage.delete(key)` | key | — | `ObjectNotFound`; `TenantScopeConflict` |
| `GET /api/public/tenant/files/<key>` (tenant-service; `/api/files/<key>` **@deprecated since 2026-09-19**, remove after the next release) | the Host, the key | the file | a neutral 404 for everything else |
| `GET /api/public/tenant/private-files/<key>?e=&n=&s=` (tenant-service, F-033-c) | the Host, the key, a signature | a **private** file, saved as `n`, on the key's tenant's Host or the platform's (it hosts every reseller's workspace, F-093-w; ADR-0113 amendment) | a neutral 404 for a bad/expired signature, a public file and everything else |
| `GET /api/public/tenant/media/<key>` / `GET /api/internal/guide-media/<key>` (tenant-service, F-018-m2-b) | a guide file's key | a 302 to the bucket, signed for an hour | a 404 for a key `guideMediaType` refuses, another tenant's on that Host, or a driver that cannot sign |
| `signedObjectUrl({key, fileName, ttlSec, secret})` / `verifySignedObject` | key, name, lifetime, `OBJECT_STORAGE_SIGNING_SECRET` | `{url, expiresAt}` — a path on the caller's Host / `true` | a secret under 32 characters throws |
| `scannerFromEnv(env).scan(bytes)` | `VIRUS_SCAN_DRIVER` (`clamd`/`none`), `CLAMD_ADDR` | `clean`, `infected` + signature, or `failed` + reason | an unknown driver or clamd with no address throws at boot |
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
   WebP, JPEG, PDF, gzip — for support's archives, F-033-n, and data exports, F-212-a — and MP4/WebM for guide videos, F-414-i) and `put` checks them: an HTML page declared a PNG is
   `type_mismatch`. SVG has no signature, so no policy can name it (catalog
   13.8).
5. **The `local` driver needs one node or a shared volume.** Replicas on
   separate disks each hold a different subset of the files. Writes are a
   temporary file renamed into place, so a reader never sees half a file.
   On k3s that is one node: every pod mounting the volume is pinned to the
   data node (hosting K17), until the move to `s3` (F-018-m2-d) needs none.
   **The `s3` driver** (`s3-driver.ts`, `@aws-sdk/client-s3`) puts with
   Content-MD5, so the store refuses a damaged body; only `NoSuchKey` reads as
   absent, an unreachable store is an error; the SDK's AWS-only CRC checksums are
   off (`WHEN_REQUIRED`), path-style by default, 5 s connect / 120 s request, 3
   attempts. Proven 2026-10-30 on Arvan `txnet-main-data`: 3 MiB written 0.8 s,
   read back with the same sha256, removed.
6. **A policy declares `visibility`** — never defaulted. A `private` file is
   never served by the public route; only `private-files` serves it, to an
   unexpired URL signed over key, expiry and file name. The owner's service
   decides who may see it and mints the URL; the port knows no owners
   (ADR-0113). PDF is served as a download, images inline.
7. **A scanner that cannot answer is `failed`, never `clean`.** `none` calls
   everything clean, for a stack with no ClamAV; production sets `clamd`.
8. **A Host serves its own keys and the platform's shared prefixes** — `PLATFORM_SHARED_PREFIXES` in `files.controller.ts`, today only `guides/` (ADR-0117 point 2): a reseller's inherited guide shows its images on the reseller's own domain. Read in the platform's scope; never a private file, never anything else of the platform's.
9. `storedObject` is in `TENANT_SCOPED_MODELS` and the table has strict RLS: on
   the app pool every query is filtered to, and bound to, the tenant in scope.
10. **`guide-media` (nginx, `dev-docker/compose/guide-media.yml`) serves guide video keys from the volume, read-only**, at `GET /api/public/media/<key>`: only `tenants/<uuid>/guides/<uuid>/<uuid>.(mp4|webm)` (its one `location`, held by `guide-video.spec.ts`), Range native, `immutable`, `nosniff`, sandbox CSP, no Host check (ADR-0118). It shares the node of the `local` volume (rule 5); an S3 driver replaces it. Its port 8081, not routed, serves every guide file (images too) by the same key shape to the bot (F-414-f). Its healthcheck asks a third server, on loopback only (hosting H24).
    **On `s3` the bucket serves them** (F-018-m2-b, ADR-0118 amendment): `GET /api/public/tenant/media/<key>` (`GuideMediaController`) answers a 302 to a GET signed for an hour (`signedReadUrl`, typed by `guideMediaType`), the redirect cached five minutes; videos only, of the Host's tenant or the platform's; no row read. The bot reads `internal/guide-media/<key>` (service token, pictures too) and follows the redirect without the token. On `local` both are a 404 and nginx serves, until F-018-m2-d removes it.
11. **A reseller's admins' files are held to `storage_mib_max`** (F-414-m, ADR-0120): `StorageQuota.assertRoom(path, bytes)` (tenant-service `files/storage-quota.ts`) before every branding and guide `put` — the bytes under `branding/` and `guides/` (`STORAGE_QUOTA_PREFIXES`), minus the file at `path`, plus the new one. Past it: `reseller_limit_reached` (409, `facts`). Support attachments are never counted; the platform's tenant is exempt. Unused guide files are swept 7 days after upload (guide contract "Upkeep").

## Backup and disk (F-414-m, ADR-0120)

- **`object-backup`** (`dev-docker/compose/object-backup.yml`, `dev-docker/backup/`): restic over the volume, read-only, nightly at `OBJECT_BACKUP_AT` (UTC, 23:00), to `OBJECT_BACKUP_REPOSITORY` (dev: a host directory; production: off the server — `s3:`, `sftp:`, `rest:`), password `secrets/object-backup-password`. Keeps 7 daily, 4 weekly, 6 monthly; `*.tmp` skipped. Writes `txnet_object_backup_last_run_success` / `_last_success_timestamp_seconds` to node-exporter's textfile directory (`NODE_TEXTFILE_DIR`). A manual run: `docker exec txnet-object-backup sh /usr/local/bin/object-backup.sh --now`. Container check: the loop's heartbeat (hosting H24).
- **Restore:** `restic restore latest --target /restore` into a spare directory, copy the `tenants/` tree into the volume, and check files against `stored_object.sha256` — the same check a move to S3 makes.
- **Alerts** (`monitoring/config-dev/storage.rules.yml`): `DiskSpaceLow` (< 15% free), `DiskSpaceCritical` (< 5%), `DiskWillFillIn24h`, `ObjectBackupStale` (no success in 36 h, or none on record), `ObjectBackupFailed`.

## The serving route

`GET /api/public/tenant/files/<key>` on `tenant-service` — public, because an
`<img>` carries no session (ADR-0065: Traefik router `tenant-public`, no `my-auth`).

- `PublicHostMiddleware` resolves the Host with `surfaceOfHost` (`shared-core`)
  and `@PublicRoute({ doors: ['panel', 'assets'] })` holds the route to `panel`
  and `assets` rows: a subdomain, or a **verified** custom domain, never a
  closed door (ADR-0063). That tenant is the scope.
- A key outside that tenant's prefix (save rule 8's shared prefixes), a key with no row, a row with no bytes,
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
| `OBJECT_STORAGE_DRIVER` | `local` or `s3`; a missing `s3` setting stops the service at boot, named |
| `OBJECT_STORAGE_S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | the `s3` driver's bucket (Arvan `hot.ir-central1.arvanstorage.ir`, `ir-central1`, `txnet-main-data`; no object lock, user 2026-10-30) |
| `OBJECT_STORAGE_S3_PATH_STYLE` | `true` (default), `false` for AWS virtual-hosted buckets |
| `OBJECT_STORAGE_LOCAL_ROOT` | the volume; `/data/objects`, mounted from `object_storage` in compose |
| `OBJECT_STORAGE_SIGNING_SECRET` | HMAC key of signed URLs, ≥32 characters; the same in tenant-service and every service that mints one. The three `OBJECT_STORAGE_*` and the scan variables are declared once, `OBJECT_STORAGE_ENV` / `VIRUS_SCAN_ENV` (`object-storage/env.ts`), and spread into each service's schema |
| `VIRUS_SCAN_DRIVER` / `CLAMD_ADDR` / `CLAMD_TIMEOUT_MS` | in a service that takes uploads (support-service, billing-service); `none` is the default |

Moving to S3: copy each file by key, check it against `sha256`, switch the
driver. No row changes.

## Not done here

- No owner check: who may see a private file is its owner's service's
  question, answered before it signs (ADR-0113 point 3).
- No rescan of `failed` files and no quarantine sweep of `infected` ones.
- No sweep of bytes with no row (a failed `put`'s orphan): the next `put` at that key overwrites it, and a guide key is never reused.
- No upload route of its own: a consumer receives the bytes and calls `put`
  (tenant's branding, F-018-h).
- No rate limit on the file route; the ETag keeps repeat views to a 304.

## Consumers

| unit | uses |
|---|---|
| tenant | branding images, `put` in the reseller's scope at `branding/<slot>` (F-018-h, [contract.branding.md](../../domains/tenant/contract.branding.md)) |
| guide | guide images, public, `guides/<guideId>/<uuid>.<ext>` of the owner; the platform's served on every Host (F-414-c, [contract.md](../../domains/guide/contract.md)) |
| guide video | MP4/WebM ≤ 50 MiB at the same path, served **only** by `guide-media` (rule 10), never by the file route's Host check (F-414-i, ADR-0118) |
| support | attachments, `private`, scanned; URLs minted on each message read (F-033-c), uploads F-033-f ([contract.md](../../domains/support/contract.md)) |
| billing | a manual transfer's receipt, `private`, scanned, under the gateway owner's prefix at `transfers/<paymentId>/receipt`; URLs minted on each queue read (F-805-a, [contract.manual-transfer.md](../../domains/billing/contract.manual-transfer.md)) |
| tenant | a reseller's data export, `private`, written by the service at `exports/<exportId>.jsonl.gz` (gzip), deleted after 7 days; URLs minted per download (F-212-a, [contract.data-export.md](../../domains/tenant/contract.data-export.md)) |
