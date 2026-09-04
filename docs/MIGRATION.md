---
id: migration
status: active
updated: 2026-09-03
---

# Migrating an existing pile of markdown into this skeleton

A large spec is roughly 4 KB per 1000 tokens: 170 KB ≈ 42k tokens, 400 KB ≈ 100k.
Reading it whole is either impossible or worse than impossible — the model keeps
half and invents the rest. **The corpus is never read whole.** A manifest is read
instead, then exact line ranges, one unit at a time.

The source folder stays **read-only** until the very end. Nothing is deleted or
moved.

---

## The one thing to understand first

Your existing docs contain two different kinds of content, and they go to two
different places:

| Content | Destination | Question it answers |
|---|---|---|
| rules, tables, contracts, how things work | `docs/domains/`, `docs/interfaces/`, `docs/platform/` | *what is the system?* |
| the list of features to build | `docs/BACKLOG.md` | *what is built and what is not?* |

Most specs mix both in the same paragraph. Splitting them is the real work of
this migration. A sentence like "invoices must be immutable once issued, and we
still need the refund screen" is one invariant plus one backlog item.

---

## Phase 0 — Scan (seconds, no reading)

```bash
python3 tools/ingest-scan.py legacy/ -o docs/_legacy/MANIFEST.md
```

Produces a few-KB table: every section as `file:line-range`, plus the table
names, identifiers (DEC-xx, INV-xx, …) and endpoints found inside it. The two
trailing columns (`→ unit`, `done`) are intentionally empty — they become the
progress tracker.

**If the corpus is one big file with no headings**, the scanner will emit a
single row. Split it first: ask for a table of contents by line range —

> Read `legacy/spec.md` in chunks of 400 lines. Output ONLY a table of contents:
> line range, topic, and whether the chunk describes *how the system works*
> or *a feature to build*. Do not summarise the content.

Then re-run the scanner, or use that table as the manifest directly.

---

## Phase 1 — Glossary (one session)

> Read `docs/_legacy/MANIFEST.md` only. From the identifier and table lists,
> fill `docs/GLOSSARY.md`. One canonical term per concept. Where two names mean
> the same thing, pick one and put the other in the banned list. Do not open the
> legacy files.

Names are the backbone. If `user`, `customer`, and `account` are not unified
now, they become three tables and three domains later.

Review this yourself. Ten minutes here saves days.

---

## Phase 2 — Unit map (one session, the critical checkpoint)

> Using `docs/_legacy/MANIFEST.md` and `docs/GLOSSARY.md`, propose the unit map
> per §1 of `docs/00-PROTOCOL.md`. Output ONLY a table: unit id, layer, one-line
> responsibility, and which manifest rows feed it. Group by table ownership
> first. Create no files.

Database tables are the best anchor for domain boundaries: tables always written
together in one transaction usually belong to one domain.

Review and correct the table. **No files exist yet** — moving a boundary is free
now and expensive after thirty files are written. Then fill the `→ unit` column.

---

## Phase 3 — Backlog (one session)

Do this *before* migrating architecture docs. It is cheaper, it gives you an
immediate picture of the project, and it makes the next phase optional.

> From `docs/_legacy/MANIFEST.md`, fill `docs/BACKLOG.md`. One row per shippable
> feature. Set `spec ref` to the exact `file:line-range` from the manifest, and
> `unit` from the unit map. Everything starts as `todo`. Where a feature is too
> large for one session, split it into sub-items. Flag anything requiring an
> architectural decision as `needs-decision`.

`spec ref` is what keeps this cheap forever: each future session reads only its
own 60 lines of the spec, never the whole file.

```bash
python3 tools/backlog.py
```

---

## Phase 4 — Reconcile against existing code

Only relevant if the project is partly built.

> Read `docs/00-PROTOCOL.md`. Run MODE: RECONCILE. Report the table. Change
> nothing until I approve.

Marks each backlog item `done` / `doing` / `todo` based on evidence in code.
It is instructed to be conservative: unsure means `doing`, never `done`.
Over-reporting progress is the most damaging mistake available here.

After approval you have a real picture: what exists, what is half-built, what
was never started.

---

## Phase 5 — Architecture docs, unit by unit

One fresh session per unit, in dependency order (units with no `depends_on`
first).

> MODE: EXTEND for unit `<id>`. Read ONLY these manifest rows: <file:range list>.
> Produce INDEX.md, contract.md, invariants.md, and rules.md / data-model.md if
> non-empty. Preserve identifiers (DEC-xx, INV-xx, …) verbatim.
> `status: draft`, `source: []`. Anything ambiguous goes to open-questions.md —
> do not resolve it yourself.

A **fresh session per unit** matters. Leftover context from the previous unit
causes concept bleed: rules from domain A get attached to domain B.

Everything stays `draft`. Those documents are intent, not verified reality.
They become `active` only when a unit's `source:` paths are filled and checked.

This phase does not have to be finished in one go. A unit can be migrated the
day you first touch it for real work.

---

## Phase 6 — Coverage

Every manifest row must end in one of three states:

| State | Meaning |
|---|---|
| mapped to a unit or a backlog item | ☑ |
| deliberately dropped | recorded in `docs/_legacy/DROPPED.md` with a reason |
| still unassigned | must be decided |

> List every manifest row with an empty `→ unit`. For each, say which unit or
> backlog item it belongs to, or why it should be dropped. Write no files.

Unassigned rows are the only place content actually gets lost. Close them here.

```bash
python3 tools/docs-check.py
python3 tools/backlog.py
```

---

## Phase 7 — Archive

Move `legacy/` to `docs/_legacy/archive/` and add to `CLAUDE.md`:

```
docs/_legacy/ is historical. Never read it during normal tasks.
Consult it only when explicitly asked to recover lost context.
```

Do not delete it until you have run on the new skeleton for a few months.

---

## Effort

| Phase | Cost |
|---|---|
| 0 Scan | seconds |
| 1 Glossary | one session + your review |
| 2 Unit map | one session + **serious** review — do not rush this |
| 3 Backlog | one session |
| 4 Reconcile | one session |
| 5 Architecture | one session per unit, spreadable over weeks |
| 6 Coverage | one session |

After phases 0–4 you can already start running `/next`. Phase 5 can proceed
lazily, unit by unit, as you reach each part of the codebase.
