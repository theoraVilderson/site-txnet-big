# ADR-0118 — Guide videos are served by a media server over the object volume, not by tenant-service

- Status: accepted (user, 2026-10-04)
- Feature: F-414 (row F-414-i)

## Context

ADR-0116 point 3 says a guide video is served by the store, never through a
Nest route: every viewer would otherwise hold a long connection on
tenant-service, which answers every tenant's public pages. Only the `local`
object-storage driver exists. Every file, logos and guide images included, is
served by tenant-service's file route, so on the `local` driver "the store"
had no server of its own. The user was asked on 2026-10-04 to choose between
that route answering Range (the cheapest, breaking point 3 until S3), building
an S3 driver first (correct, large, and blocking F-414-i and the bot's video),
and a separate server over the same volume. They chose the last.

## Decision

1. **`guide-media`, an nginx container, mounts the object volume read-only**
   and serves `GET /api/public/media/<key>` (Traefik strips the prefix). Range,
   `sendfile` and long downloads are nginx's; tenant-service holds no viewer.
2. **It serves guide video keys and nothing else.** Its one `location` matches
   `tenants/<uuid>/guides/<uuid>/<uuid>.(mp4|webm)`, which only `GuideAdmin`
   mints. Every other path on the volume is a 404: branding, support
   attachments, a `.tmp` the driver is still writing, a climb with `..`.
   Images and posters stay on the file route, with its Host check.
3. **No Host or tenant check.** A guide is public wherever it is shown, the
   platform's are every Host's (ADR-0117 point 2), and a key holds two random
   uuids. A reseller's video can therefore play on another domain if its key
   is known, which shows nothing a visitor to that reseller's panel cannot see.
4. **Keys are immutable**: one per upload, never rewritten, so the answer is
   `Cache-Control: public, max-age=31536000, immutable`. It is also `nosniff`
   and a sandboxing CSP, like the file route.
5. **The panel builds the URL in one place** (`guideVideoUrl`). An S3 driver
   replaces this container with the bucket or a CDN by changing that builder
   and nothing stored.

## Consequences

- On the `local` driver `guide-media` must run where tenant-service's volume
  is (object-storage rule 5); swarm has no app services yet, so this binds
  only the day it does.
- `guide-video.spec.ts` reads `dev-docker/media/guide-media.conf` and fails if
  its location serves more than guide videos.
- Videos up to 50 MiB are held in tenant-service's memory while uploading, as
  images are. Streaming the upload to disk becomes worth it with S3's
  multipart upload, not before.
