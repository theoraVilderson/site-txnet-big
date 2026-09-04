---
id: migration
status: active
updated: 2026-09-04
---

# Folding an existing spec into this skeleton

You have a pile of markdown — one big file or many — describing features, rules,
database tables and how things should work. This is how it becomes a catalog, a
backlog, and a set of unit docs, without anyone ever reading the pile whole.

A large spec is roughly 4 KB per 1000 tokens: 170 KB ≈ 42k tokens, 400 KB ≈ 100k.
Reading it whole is worse than impossible — the model keeps half and invents the
rest.

The source stays **read-only** until the last phase. Nothing is deleted or moved.

---

## The one thing to understand first

Your existing docs contain three kinds of content, and they go to three different
places:

| Content | Destination | Question it answers |
|---|---|---|
| the list of things to build | `docs/features/App-Features.md` | *what should exist?* |
| what is actually built | `docs/BACKLOG.md` | *what is done, what is not?* |
| rules, tables, contracts, invariants | `docs/domains/`, `interfaces/`, `platform/` | *how does the system work?* |

Most specs mix all three in the same paragraph. Separating them is the real work.
A sentence like "invoices are immutable once issued, and we still need the refund
screen" is one invariant plus one catalog feature.

**Order matters.** Catalog first, then backlog, then unit docs. The catalog is
the only thing that must be complete; the other two are filled lazily, area by
area, as you build.

---

## Phase 0 — Table of contents (one session)

Do not read the spec. Get its shape.

> Read `legacy/spec.md` in chunks of 400 lines. Output ONLY a table of contents:
> line range, topic, and whether the chunk describes *a feature to build*, *a
> rule about how something works*, or *both*. Do not summarise the content.

If the spec already has headings, `grep -n '^#' legacy/*.md` gets you most of the
way for free.

Keep the result as `docs/features/.toc.md`. It is scaffolding — deleted at the
end. Every later phase cites line ranges from it, so nothing after this phase
needs to scan the spec again.

---

## Phase 1 — Glossary (one session)

> Read `docs/features/.toc.md` and grep the spec for table and entity names.
> Fill `docs/GLOSSARY.md`. One canonical term per concept. Where two names mean
> the same thing, pick one and put the other in the banned list.

Names are the backbone. If `user`, `customer` and `account` are not unified now,
they become three tables, three domains and a migration.

Review this yourself. Ten minutes here saves days.

---

## Phase 2 — Decisions, constraints, invariants (one session)

Before any feature row, extract the rules that outrank features. These become
the `D-nn` / `C-nn` / `INV-nn` tables at the top of the catalog.

> Read `docs/FEATURES-FORMAT.md` §5. Then read only the spec chunks the TOC
> marked as *rule*. Produce three tables: Decisions (D-nn), Constraints (C-nn),
> Invariants (INV-nn). For every invariant, state the blast radius if broken.
> Where two parts of the spec contradict each other, do not resolve it — record
> it as a `C-nn` conflict with both sides stated, and ask me.

This phase is where a spec's real contradictions surface. Expect to answer
questions. Every conflict settled here is one that cannot resurface in six
months, because the resolution is recorded with its reason.

Invariants are worth more than the feature rows. Extract them explicitly rather
than leaving them buried in prose.

---

## Phase 3 — Catalog, section by section (one session per area)

> Read `docs/FEATURES-FORMAT.md` in full. Then read ONLY these TOC ranges:
> <ranges for one area>. Write Section NN of `docs/features/App-Features.md` in
> exactly that format: `### N.N` sub-sections, prose, owned state block, then the
> feature table. Ids are permanent — assign them sequentially and never reuse.
> Preserve any identifiers already in the source verbatim.
> Anything ambiguous becomes a question, not an invented feature.

One area per session. Fresh session each time: leftover context from the previous
area causes concept bleed, where rules from one area get attached to another.

After each area:

```bash
python3 tools/features-scan.py --check
```

Fix what it reports before starting the next area. A malformed catalog propagates
its damage into every backlog row derived from it.

This phase is the bulk of the work. A 170 KB spec is typically 6–12 areas.

---

## Phase 4 — Units (one session)

The catalog says *what*. Units say *where it lives*.

> Read `docs/features/MANIFEST.md` and `docs/GLOSSARY.md` only. Propose the unit
> map per §1 of `docs/00-PROTOCOL.md`. Output ONLY a table: unit id, layer,
> one-line responsibility, and which catalog sections feed it. Group by table
> ownership first. Create no files.

Database tables are the best anchor for domain boundaries: tables always written
together in one transaction usually belong to one domain.

Review and correct this. **No files exist yet** — moving a boundary is free now
and expensive after thirty files are written. Then fill `docs/MASTER_INDEX.md`
and copy `_TEMPLATE-unit/` for each unit.

---

## Phase 4b — Surfaces (one session, only if a UI already exists)

The unit map says where code lives. The surface map says what the **user** can
point at, so you never have to type a path again.

> Read `docs/SURFACES.md` for the format. List the routes and top-level
> components under `code_roots:`. Propose one row per screen, plus one per
> control that would ever be edited on its own. Aliases must be the words a
> person would actually say — not the component name. Output the table only.

Ten rows is enough to start. The map is meant to be filled by use: every time a
query misses, the phrasing that failed becomes an alias in the same turn as the
fix. A map that is completed up front and never touched again decays; this one
gets sharper the more it is used.

```bash
python3 tools/where.py --check     # every row points at a file that exists
```

---

## Phase 5 — Ingest the first area

> Run MODE: INGEST for area 01.

Turns catalog rows into backlog rows. `spec ref` is the catalog **id**, never a
line range. Only the area you are about to build — an area you are not building
costs you nothing.

If a feature has no home unit, INGEST stops and asks. That is correct behaviour,
not a failure: it means a unit is missing or a boundary is wrong.

---

## Phase 6 — Reconcile against existing code

Only if the project is partly built.

> Run MODE: RECONCILE.

Marks each backlog row `done` / `doing` / `todo` based on evidence in code.
It is instructed to be conservative: unsure means `doing`, never `done`.
Over-reporting progress is the most damaging mistake available here.

After approval you have a real picture: what exists, what is half-built, what was
never started. From here, `/next` works.

---

## Phase 7 — Unit docs, lazily

Unit `contract.md`, `rules.md`, `invariants.md` and `data-model.md` do **not**
need filling up front. Fill a unit's docs the day you first do real work in it:

> MODE: EXTEND for unit `<id>`. Read only `python3 tools/spec.py --area NN` and
> the existing code under `source:`. Fill contract.md and invariants.md.
> Invariants come from the catalog's INV table — copy them verbatim, do not
> rephrase.

Everything stays `draft` until `source:` paths are filled and verified. Those
documents are intent until proven against code.

---

## Phase 8 — Archive

```bash
rm docs/features/.toc.md
mkdir -p docs/_archive && mv legacy/ docs/_archive/
```

Add to `CLAUDE.md`:

```
docs/_archive/ is historical. Never read it during normal tasks.
Consult it only when explicitly asked to recover lost context.
```

Do not delete it until you have run on the skeleton for a few months. From this
point the catalog is the spec — changes go into `App-Features.md` with a version
bump, never back into the archive.

---

## Effort

| Phase | Cost |
|---|---|
| 0 TOC | one session |
| 1 Glossary | one session + your review |
| 2 D / C / INV | one session + **your decisions** — expect questions |
| 3 Catalog | one session per area, 6–12 areas for a 170 KB spec |
| 4 Unit map | one session + **serious** review — do not rush this |
| 5 Ingest | one session per area, on demand |
| 6 Reconcile | one session |
| 7 Unit docs | spread over weeks, as you touch each unit |

Phases 0–4 are the migration. Everything after is normal operation.
