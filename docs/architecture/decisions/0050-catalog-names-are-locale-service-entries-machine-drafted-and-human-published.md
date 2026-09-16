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

## Amendment 2026-09-16 — keys are tenant-scoped and the server's (F-1533-d)

Found while building F-1533-d: a product or category key is unique only
**inside a tenant**, and `nameKey` was free input. Decision 2's
`catalog.product.<key>.name` would let two resellers with the same key share
one name, and a reseller naming a platform product's key would rewrite the
platform's text for everyone. The user's call: **the server derives every key,
tenant-scoped** — `catalog.<kind>.<key>.<field>` for platform rows,
`catalog.t_<tenant id, no dashes>.<kind>.<key>.<field>` for a tenant's. A
category or product body carries text, never a key; a review write is allowed
only on a key naming an item the caller manages. Rejected: one shared key per
item key (the collision stays); client-sent keys validated by prefix (the same
safety, more input to get wrong).

## Amendment 2026-09-16 (2) — each item has a source language (F-1533-f/g)

The user's call, replacing decision 4's fixed fa+en and, **for catalog text
only**, decision 5's en → fa chain:

- The admin picks an item's **source language** (any language locale-service
  has); the form defaults to `DEFAULT_LANGUAGE`. Only the source text is
  required; any other language written in the same form is published as
  written. Every language not written is drafted **from the source**.
- Reading catalog text: requested language → **the item's source language** →
  the key. The fallback is the admin's choice through the source language;
  no viewer or tenant setting.
- `sourceLang` is a nullable column on `product_category` and `product`; a row
  from before this amendment reads as `DEFAULT_LANGUAGE`.
- The clients' generic en → fa chain (F-1533-c) stays for every other
  namespace; a catalog reader passes the item's source language instead.

## Amendment 2026-09-16 (3) — a local LLM drafts first (F-1533-h)

Argos drafts of short Persian names were too weak to review. The user's call:
the engine stays **free and local** — it must run offline or on the national
internet — but a **local LLM is allowed**. Decision 1 now reads:

- `OpenAiCompatibleTranslator` speaks the OpenAI chat API to a model on the
  deployment (`TRANSLATOR_LLM_URL`, `TRANSLATOR_LLM_MODEL`); dev-docker runs
  Ollama as `translator-llm` with `qwen2.5:3b` (~2 GB, ~3-4 GB RAM, no GPU).
  The prompt says what the text is (a store name) and asks for the translation
  alone; quotes, labels and a stray note are stripped, and an answer in a CJK
  script neither language uses is no draft.
- `FallbackTranslator` asks the LLM, then LibreTranslate. Either unset is
  skipped; both unset is `NullTranslator`. Drafts stay drafts: a human publishes.
- A hosted API stays refused. ollama.com's blob store is unreachable from some
  networks: `scripts/translator-llm-import.sh` loads the same model from a GGUF
  file downloaded anywhere.

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
- **A hosted translation API** — refused by the user: not local. (A local LLM
  was refused too, then allowed by amendment 3.)
