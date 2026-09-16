---
id: adr-0050
status: accepted
updated: 2026-09-16
---

# ADR 0050 — Catalog names are locale-service entries, machine-drafted and human-published

- **Status:** accepted 2026-09-16 (rows F-1533-a..e)
- **Date:** 2026-09-16
- **Affects units:** i18n, catalog, panel-web

## Context

§4.3 makes a product's name and description i18n keys, and ADR-0049 built the
catalog that way — but nothing ever writes the value of such a key. The panel
shows the product's `key`, and every language sees nothing meaningful.

`locale-service` serves only `locales/`, a git-tracked tree mounted read-only:
content changes by commit, never at runtime. An admin creating a product is a
runtime write. The platform will add languages later (§1.1: a language is data,
so no list of them may live in code), and nobody will hand-type a product name
into every one. F-1533 asks for machine translation with **mandatory human
review**; the user ruled out AI and any hosted API — the engine must be local
and portable.

## Decision (D-36, the user's calls, all as recommended)

1. **A local translation engine behind a port.** `Translator` in `shared-core`
   (`translate(text, from, to)`, `languages()`); the first driver is
   LibreTranslate (Argos models), a `translator` container in dev-docker and
   swarm with its models on a volume. No network call leaves the deployment.
   An unreachable engine or an unsupported pair yields no draft — never an
   error to the admin.
2. **A writable overlay inside locale-service.** `LOCALES_RUNTIME_DIR` (a
   volume, never git) has the same layout as `locales/` and is merged over it
   per key. Catalog text lives in the `catalog` namespace under `shareds`, so
   the panel, the bot and the backend all receive it. Keys stay
   `catalog.product.<key>.name` / `.description`, `catalog.category.<key>.name`.
3. **Drafts are not served.** Runtime writes carry a state: `published`
   entries enter snapshots and `Watch`; `draft` entries are kept apart and read
   only by a review RPC. New RPCs: `SetEntries`, `ListDrafts`, `PublishDrafts`.
4. **The admin writes the source languages, the engine drafts the rest.** The
   catalog form requires `fa` and `en`; they are published as written. Every
   other language `languages()` reports gets a machine draft. A language added
   later is drafted by a "translate missing" action, not by code.
5. **Fallback at read:** requested language → `en` → `fa` → the key itself. A
   language with no published text still reads a meaningful name.

## Consequences

- locale-service stops being read-only; a write RPC on an unauthenticated
  service is acceptable only while it stays on the private network (i18n
  open question, 2026-09-04). Only `billing-service` calls it.
- The runtime volume is state to back up, like the database.
- A reseller's own override of a name (§4.3, F-317) is the same overlay with a
  tenant namespace — not built by these rows.
- Product text is no longer in git history; `SetEntries` is audited by the
  catalog write that triggers it.

## Alternatives considered

- **A translation table in the `catalog` schema** — simpler, but text in the
  record is exactly what §4.3 forbids, and F-317's per-tenant override would
  need a second mechanism.
- **Commit translations into `locales/`** — a runtime admin action cannot
  commit, and a swarm deploy does not mount the repo.
- **An LLM or a hosted translation API** — refused by the user: not local.
