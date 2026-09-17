---
id: object-storage
layer: platform
status: draft
version: 1
keywords: [object storage, file storage, upload, uploaded file, attachment storage, logo upload, asset storage, storage driver, local storage, s3, bucket, stored object, serve a file, آپلود فایل, ذخیره فایل, فضای ذخیره‌سازی, لوگو آپلود, اس۳]
source: []
owns_tables: []
depends_on: [tenant-context]
updated: 2026-09-17
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

`draft`, no code. Opened by D-42 (3), 2026-09-17; first built by F-018-m, first
consumer F-018-h.

## Changelog
| Date | Change |
|---|---|
| 2026-09-17 | Unit opened by D-42 — no code yet |
