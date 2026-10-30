---
id: object-storage
layer: platform
status: active
version: 5
keywords: [object storage, file storage, upload, uploaded file, attachment storage, logo upload, signed url, private file, virus scan, clamav, pdf, asset storage, storage driver, local storage, s3, bucket, stored object, serve a file, آپلود فایل, ذخیره فایل, فضای ذخیره‌سازی, لوگو آپلود, اس۳]
source:
  - txnet-backend/shared-core/src/lib/object-storage/**
  - txnet-backend/tenant-service/src/app/files/**
  - txnet-backend/prisma/domains/storage.prisma
  - dev-docker/media/**
  - dev-docker/compose/guide-media.yml
  - dev-docker/compose/object-backup.yml
  - dev-docker/backup/**
  - dev-docker/monitoring/config-dev/storage.rules.yml
  - scripts/objects/**
owns_tables: [storage.stored_object]
depends_on: [tenant-context]
updated: 2026-10-30
---

# object-storage

**Responsibility (one sentence):** store, serve and delete uploaded files by a
tenant-prefixed key behind one port, whatever holds the bytes (local volume
today, S3-compatible later).
**Explicitly NOT responsible for:** what a file means to its owner — branding
(`tenant`), ticket attachments (`support`) and exports keep their own rows and
cite a key.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | storing, serving or deleting a file, or adding a driver |

## Status

`active`. Built by F-018-m: the port and the `local` driver in `shared-core`,
`stored_object` in its own `storage` schema, and the public serving route in
`tenant-service`. First consumer: tenant's branding (F-018-h). The `s3` driver
(F-018-m2-a) is built; dev runs on it (F-018-m2-d, txnet-main-data), production on the volume until F-018-m2-d2.

## Changelog
| Date | Change |
|---|---|
| 2026-09-17 | Unit opened by D-42 — no code yet |
| 2026-09-18 | draft -> **active**, v1 -> v2 (F-018-m): the port, the `local` driver, `stored_object`, `GET /api/files/<key>` |
| 2026-09-19 | v2 -> **v3** (**break**, F-018-ak, ADR-0065): the serving route is `GET /api/public/tenant/files/<key>`; `/api/files/<key>` is `@deprecated`, removed after the next release. URLs are built at read time, so nothing stored changes |
| 2026-10-03 | v3 -> **v4** (**break**, F-033-c, ADR-0113): `UploadPolicy.visibility` is required; private files, signed URLs on `private-files`, the virus-scan port, PDF |
| 2026-10-04 | v4 -> v5 (F-414-m, ADR-0120): `storage_mib_max` checked before every admin upload (rule 11); nightly restic backup and disk alerts ("Backup and disk") |
