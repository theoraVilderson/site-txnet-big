# ADR-0115 — Guides are a unit of their own, inherited from the platform by key

- Status: accepted (user, 2026-10-04)
- Feature: F-414 (broadened 2026-10-04)

## Context

F-414 was one sentence: a per-OS install guide in the panel and the bot. The
user widened it to every kind of help a product needs — a guide per product,
per operating system, per app and per panel/bot section, in each language,
shown where it is placed. A reseller sells the platform's products under its
own brand, so most of its guides are the platform's, and some must be its own.

Two choices are expensive to reverse once rows exist: where the guides live,
and how a reseller's set relates to the platform's.

## Decision

1. **A unit of its own, `guide`, with its own Postgres schema (`guide`).**
   Help is content, not something for sale, so it is not `catalog`'s; it is
   not branding either. It runs as a module inside `tenant-service`, which
   already serves a tenant's public content per Host — no new service. The
   schema is its own so a later `guide-service` moves code, never data.
2. **Inherited by key, the support categories' pattern (ADR-0112 point 6).**
   A guide has a stable `key`. `tenantId` NULL is the platform's; every
   reseller sees it with no work. A reseller's own guide with the same key
   replaces it for that reseller; a hide row removes it without replacing it.
   A platform edit reaches every reseller that has not replaced or hidden it.
3. **Room for a chain.** Resolution is "nearest owner wins" over a tenant's
   ancestry. Today the ancestry is the reseller then the platform; a
   sub-reseller (F-312) adds a link to the same walk, not a new model.
4. **Text per language** in its own table, and **placement** in its own
   table — one guide may appear on several panel routes, bot screens,
   products, OSes or apps.

## Consequences

- Copying the platform's guides into each reseller at creation was rejected:
  every platform update would then reach no one.
- A platform-only set was rejected: a white-label reseller could not say
  anything its own way.
- `tenant-service` gains a module and a schema; the reading route is the one
  the panel and the bot both use (ADR-0009).
