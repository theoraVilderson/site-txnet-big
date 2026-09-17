---
id: object-storage
layer: platform
status: draft
version: 1
updated: 2026-09-17
---

# Contract — object-storage

**DRAFT — intended, no code.** The shape decided by D-42 (3); F-018-m builds it.

## TL;DR

One port in `shared-core`. A driver is chosen by environment: `local` (a mounted
volume) now, S3-compatible later. Callers hold a **key**, never a path or a URL,
so changing the driver moves bytes and changes no row.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| put | tenant (from context), logical path, bytes, contentType | key + `stored_object` row | sync | too large / type not allowed |
| get / stat | key | bytes + contentType / metadata | sync | not found / other tenant |
| delete | key | — | sync | not found |
| serve | key (one HTTP route) | the file | sync | not found / other tenant |

## Rules (intended)

1. A key is `tenants/<tenantId>/<logical path>` — the same string is a path on
   the local volume and an object key in a bucket.
2. The database stores keys only. A public URL is built at render time from the
   tenant's current asset domain, because domains rotate (F-102, F-105).
3. Every file has a `stored_object` row: key, tenantId, contentType, size,
   sha256 — a migration to S3 is verified against it.
4. A caller's allowed types and size are declared per use (branding: PNG/WebP,
   no SVG — catalog 13.8), never defaulted.
5. **The `local` driver needs one node or a shared volume.** Swarm replicas on
   separate disks lose files.

## Consumers (intended)

| unit | uses |
|---|---|
| tenant | branding assets (F-018-h) |
| support | ticket attachments (not yet in the backlog) |
