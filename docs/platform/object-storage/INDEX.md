---
id: object-storage
layer: platform
status: active
version: 2
keywords: [object storage, file storage, upload, uploaded file, attachment storage, logo upload, asset storage, storage driver, local storage, s3, bucket, stored object, serve a file, آپلود فایل, ذخیره فایل, فضای ذخیره‌سازی, لوگو آپلود, اس۳]
source:
  - txnet-backend/shared-core/src/lib/object-storage/**
  - txnet-backend/tenant-service/src/app/files/**
  - txnet-backend/prisma/domains/storage.prisma
owns_tables: [storage.stored_object]
depends_on: [tenant-context]
updated: 2026-09-18
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
`tenant-service`. First consumer F-018-h (not yet built).

## Changelog
| Date | Change |
|---|---|
| 2026-09-17 | Unit opened by D-42 — no code yet |
| 2026-09-18 | draft -> **active**, v1 -> v2 (F-018-m): the port, the `local` driver, `stored_object`, `GET /api/files/<key>` |
