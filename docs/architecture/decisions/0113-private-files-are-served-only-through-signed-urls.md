---
id: adr-0113
status: accepted
updated: 2026-10-03
---

# ADR 0113 — private files are served only through signed URLs, past a virus scan

- **Status:** accepted (F-033-c the port, the route and the read side; F-033-f the upload)
- **Date:** 2026-10-03. The split into F-033-c / F-033-f was the user's; the
  rest follows from ADR-0112 point 7 and D-8.
- **Affects units:** object-storage, support, tenant (hosts the route)

## Context

Every file the storage port held was public: branding, served by Host to
anyone (`GET /api/public/tenant/files/<key>`). A support attachment is a
user's invoice or screenshot — catalog §11.4 wants it behind a short-lived
link, and a user's upload must not reach an agent unscanned. ADR-0112 point 7
already said: no URL stored, a 5-minute one minted on read.

## Decision

1. **A stored file is `public` or `private`, declared by the upload policy**
   (`UploadPolicy.visibility`, required — never defaulted, like types and size)
   and recorded on `stored_object.private`. The public route answers a private
   file with the same 404 as a missing one.
2. **A private file is served by `GET /api/public/tenant/private-files/<key>?e=&n=&s=`**
   on tenant-service, beside the public route and under the same Host rule
   (panel or assets door, the key's tenant must be the Host's). `s` is an
   HMAC-SHA256 over key, expiry and file name with
   `OBJECT_STORAGE_SIGNING_SECRET`, shared by the minting service and
   tenant-service. The URL carries no session, so the bot can hand it on.
3. **The owner checks who may see the file; the URL is the permission.** The
   service that owns the meaning of a file (support: the conversation's user)
   mints the URL only after its own check, and only for five minutes. The port
   knows nothing about owners.
4. **Bytes are scanned before anyone else may fetch them** — a `VirusScanner`
   port in `shared-core`: `clamd` (ClamAV INSTREAM over TCP) or `none`
   (`VIRUS_SCAN_DRIVER`). A scanner that cannot answer is `failed`, never
   `clean`; support mints a URL only for `clean`. `none` calls every file
   clean and is for a stack with no ClamAV container — production sets
   `clamd`.
5. **PDF is a sniffable type** (`%PDF-`). It is served as a download
   (`Content-Disposition: attachment`); PNG/WebP/JPEG inline. Both keep
   `nosniff` and a sandboxing CSP.

## Consequences

- A leaked URL works for at most five minutes, and only on its tenant's Host.
- Rotating the secret kills every outstanding URL — harmless, they are minted
  per read.
- A ClamAV container is one more process in production (≈1 GB RAM for its
  signatures); without it the files are stored but unscanned by choice.

## Revisit trigger

A file must be fetched by someone the owner cannot name at signing time, or
an S3 driver should serve private files straight from the bucket with its own
presigned URLs.

## Amendment 2026-10-19 — the platform's Host

Decision 2's Host rule had one gap: a reseller's workspace (F-093-w) is on the
platform's panel, so its customers' receipts, keyed under the reseller, were a
404 there. `private-files` now also serves a signed key of **any** tenant on
the platform's Host, read in the key's tenant's scope; another reseller's Host
still answers 404. The signature stays the permission (decision 3) — billing
mints it only for a reviewer it has already checked.
