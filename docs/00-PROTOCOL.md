---
id: protocol
status: fixed
version: 2.0
updated: 2026-09-04
---

# DOCS PROTOCOL v2 — fixed file. Copy verbatim into every project. Never edit without explicit user request.

> **v2 adds the feature-catalog layer.** New: `/features` in §1, tier 1b in §3,
> and `MODE: INGEST` (§6d). Everything from v1 is unchanged.

You are operating on a documentation tree that is the shared memory between the
user, you, and future agents. These rules override your defaults.

---

## 0. AUTHORITY ORDER (resolve every conflict with this list)

1. **Running code + schema/IDL** (Prisma/SQL/proto/OpenAPI) — truth about WHAT IS.
2. **`invariants.md`** — truth about WHAT MUST NEVER BREAK. Outranks convenience, always.
3. **ADRs** (`architecture/decisions/`) — truth about WHY. Never contradict an
   `accepted` ADR; supersede it with a new ADR instead.
4. **`contract.md` / `rules.md`** — truth about WHAT SHOULD BE (intent).

If (1) and (4) disagree: **STOP. Report drift.** Do not silently rewrite either
one. Ask which side is wrong.

**Never duplicate a fact that lives in code.** If a field list exists in a schema
file, link to it (`source:` front matter + path). Duplication is the #1 cause of
rotten docs.

---

## 1. LAYOUT (fixed — never restructure without explicit request)

```
/docs
  00-PROTOCOL.md        this file
  MASTER_INDEX.md       one line per unit. entry point for every task.
  BACKLOG.md            one row per shippable feature. what is built vs not.
  GLOSSARY.md           canonical names. one term = one meaning, project-wide.
  FEATURES-FORMAT.md    fixed. the authoring contract for the catalog.
  PROMPTS.md            copy-paste prompts for the user

  /features             the product's feature catalog — NEVER read whole
    App-Features.md     hand-written, in FEATURES-FORMAT.md shape
    MANIFEST.md         GENERATED index: block -> line range, id -> block
    DROPPED.md          catalog ids deliberately not built, with reasons

  /architecture
    overview.md         system shape, ≤150 lines
    tech-stack.md       what + version + why
    dependency-graph.md GENERATED where possible + manual runtime edges
    /decisions          0001-*.md — one ADR per irreversible decision

  /domains              business logic. owns rules + data.
  /interfaces           anything the outside world touches (API, bot, panel, webhook)
  /platform             cross-cutting capability, no business rules
                        (i18n, observability, error taxonomy, auth middleware, ledger primitives)

  /operations           runbooks, migrations, environments, on-call
  /security             threat-model.md, secrets policy, tenancy isolation
```

**Unit** = one folder under `domains/`, `interfaces/`, or `platform/`.
Placement test, in order:
- Has business rules and owns state → `domains/`
- Translates between outside world and domains, no rules of its own → `interfaces/`
- Used by ≥2 units and has no business meaning → `platform/`

Every unit folder contains: `INDEX.md` (required), `contract.md` (required),
plus `rules.md`, `invariants.md`, `data-model.md`, `open-questions.md` **only if
non-empty**. Never create an empty file.

---

## 2. FRONT MATTER (required at the top of every unit file)

```yaml
---
id: billing              # stable, kebab-case, unique, never renamed
layer: domain            # domain | interface | platform | operations | security
status: active           # draft | active | deprecated | superseded
version: 2               # contract version. bump = breaking change.
source:                  # real code paths. empty means NOT IMPLEMENTED YET.
  - apps/api/src/modules/billing/**
owns_tables: [invoice, ledger_entry]
depends_on: [identity, notification]
updated: 2026-09-03
---
```

`source:` is what makes docs auditable. A unit with `status: active` and empty
`source:` is a lie — mark it `draft`.

---

## 3. READ PROTOCOL (token discipline — this is not optional)

Read in tiers. Stop at the shallowest tier that answers the question.

| Tier | Read | When |
|---|---|---|
| 0 | `MASTER_INDEX.md` | **always**, first, every task |
| 1 | target unit `INDEX.md` | always |
| 1b | `python3 tools/spec.py <F-id>` | the backlog row names a `spec ref` |
| 2 | target `contract.md` + `invariants.md` | changing or using the unit |
| 3 | `contract.md` of each `depends_on` — **the API section only** | writing code |
| 4 | `rules.md`, `data-model.md` | writing code *inside* that unit |
| 5 | actual source files under `source:` | implementing |

**Blast radius** = the unit + every unit listing it in `depends_on`
(consumers). Read consumers' `contract.md` only when changing a public contract.

Hard limits:
- Never read all of `/docs`, all of `/domains`, or any unit outside the blast radius.
- **Never open `features/App-Features.md` directly.** It is thousands of lines.
  `tools/spec.py` prints the one block you need; `features/MANIFEST.md` is the
  only index you may scan. Opening the catalog is the single most expensive
  mistake available in this repo.
- If a task appears to need >8 doc files, **stop and say so** — that is a signal
  the change is too broad or a unit is badly split.
- Never re-read a file already in this conversation's context.

---

## 4. MODE: BOOTSTRAP (new project from a description)

1. Extract units from the description using the §1 placement test. Business
   concern ≠ technical module: "sending SMS" is `platform/notification`, "who may
   buy what" is `domains/entitlement`.
2. Write `GLOSSARY.md` **first**. Every noun the user used → one canonical term.
   This prevents `user`/`customer`/`account` becoming three tables.
3. Per unit: `INDEX.md` + `contract.md` with front matter, `status: draft`,
   `source: []`.
4. Extract **invariants** explicitly — ask the user "what must never happen?"
   These are worth more than the contracts.
5. Every irreversible choice (datastore, auth model, tenancy model, money
   representation) → an ADR, even if the user stated it casually.
6. Fill `MASTER_INDEX.md` and `dependency-graph.md`.
7. Missing info → `open-questions.md` + ask. **Do not invent fields, tables, or
   endpoints.**
8. Report at the end: units created, ADRs written, open questions count.

## 5. MODE: EXTEND (add/change a feature)

1. Read Tier 0–1. Announce the classification **before** writing anything:
   - fits an existing unit → edit only that unit
   - new independent concern → new unit
   - spans units → name every touched unit and its blast radius
2. Check `GLOSSARY.md` before introducing any new noun. Reuse or justify.
3. Public contract change? → §7 first.
4. After the change, in the same turn, update: unit `INDEX.md`,
   `dependency-graph.md` (only if a new edge), `MASTER_INDEX.md` (only if a new
   unit), `CHANGELOG` line in the unit's `INDEX.md`.
5. Uncertainty → §8. Never a silent default.

## 6. MODE: IMPLEMENT (write code)

1. Tiers 0–5 for the target unit only.
2. Before coding, state in ≤5 lines: files to create/modify, invariants in play,
   consumers at risk.
3. Follow the tech-stack and existing patterns in `source:` over your own
   preferences. Read one neighbouring file for style before writing a new one.
4. Code must not violate any `invariants.md` entry. If the requested feature
   requires violating one, **stop and say which one**.
5. After code: update `source:` paths and flip `status: draft → active`.

## 6b. MODE: NEXT (the delivery loop — one feature per session)

This is the mode to use for "just keep going". It exists so a fresh session with
zero context can resume work correctly and cheaply.

1. Read **only** `MASTER_INDEX.md` and `BACKLOG.md`. Nothing else yet.
2. Pick the first item with `status: todo` whose every `depends_on` item is
   `done`. If several qualify, prefer the one whose unit already has
   `status: active` (cheaper — the unit exists).
   If none qualify, say so and list what is blocking.
3. **Announce before working:** item id, feature, target unit, spec ref, and the
   files you will touch. Then proceed without waiting, unless the item is
   flagged `needs-decision`.
4. Read Tier 1–5 for the target unit only, plus the item's spec via
   `python3 tools/spec.py <spec ref>`. Never open the catalog file.
5. Implement per MODE: IMPLEMENT (§6).
6. Update in the same turn:
   - backlog row → `status: doing` at start, `done` at end
   - the unit's `source:` paths and `status`
   - the unit's INDEX changelog (one line)
7. **Stop.** One item per session. Report: what shipped, what is now unblocked,
   what needs a decision from the user.

Never mark an item `done` if a blocking open question is open, an invariant is
violated, or the code was not actually written. `done` means code exists.
Half-finished work stays `doing` with a note — never silently `done`.

## 6c. MODE: RECONCILE (half-built project — run this once, first)

For a project where code already exists but the backlog does not reflect it.

1. Read `BACKLOG.md` and the code tree structure (not file contents).
2. For each backlog item, find evidence in code. Mark:
   - `done` — implemented and reachable. Record the proving path.
   - `doing` — partially implemented. Note what is missing, concretely.
   - `todo` — no trace in code.
3. Report a table. **Change no code.** Ask before writing the results back.
4. Anything found in code but absent from the backlog → new backlog row,
   `status: done`, flagged `undocumented`.

Be conservative: a file existing is not proof a feature works. When unsure,
mark `doing`, not `done`. Over-reporting progress is the most damaging error
this mode can make.

## 6d. MODE: INGEST (feature catalog -> backlog, one area at a time)

Turns `features/App-Features.md` rows into `BACKLOG.md` rows. Run it **once per
area, the day you start building that area** — never for the whole catalog at
once. Lazy ingest is what makes a 3000-line catalog affordable: an area you are
not building costs you nothing.

1. `python3 tools/features-scan.py --check` — if it errors, fix the catalog
   first. Ingesting a malformed catalog propagates the damage into the backlog.
2. Read `features/MANIFEST.md` **only** — pick the target area's blocks.
3. `python3 tools/spec.py --area <NN>`. This is the only spec text you read.
4. One BACKLOG row per catalog feature:
   - `id` — the catalog id **verbatim**. Never renumber, never invent.
   - `unit` — from `MASTER_INDEX.md`. A feature with no home unit is a
     **BLOCKING** question (§9): it means a unit is missing or a boundary is
     wrong. Stop and ask. Do not invent a unit mid-ingest.
   - `spec ref` — the catalog id again, **never a line range**. Line numbers
     shift on the next catalog edit; ids do not.
   - `status` — always `todo`. A catalog `status: later` still gets a row,
     noted `later`.
   - `depends_on` — the catalog's, plus any backlog item that must land first.
5. A catalog feature too large for one session is split **here**, into
   `F-xxxx-a` / `F-xxxx-b`, with the split recorded in `note`. Do not edit the
   catalog to fix sizing — the catalog is the spec, the backlog is the plan.
6. Deliberately not building something? → `features/DROPPED.md`, with a reason
   and a date. **Never silently omit a catalog id.**
7. `python3 tools/features-scan.py --check` again. Coverage must show the area
   fully accounted for: every id either has a backlog row or is in DROPPED.md.
8. Report: rows added, units touched, ids with no home unit, ids dropped.

INGEST writes **only** BACKLOG rows. No code, no unit files, no catalog edits.
If the ingest reveals that a unit is missing, that is a finding to report — not
something to fix in the same pass.

## 7. MODE: AUDIT (drift check)

For each unit: does every `source:` path exist? Does `owns_tables` match the
schema? Any `ASSUMED:` older than 30 days? Any `status: active` with empty
`source:`? Any unit not reachable from `MASTER_INDEX.md`? Report a table. Fix
nothing without approval.

Then the mechanical half — run all three, report the output verbatim:

```bash
python3 tools/docs-check.py            # front matter, source: paths, reachability
python3 tools/backlog.py               # progress, dependency sanity, next eligible
python3 tools/features-scan.py --check # catalog format + backlog coverage
```

A green audit means: no unit lies about being implemented, no backlog row cites
a catalog id that does not exist, and no catalog feature is silently missing
from both the backlog and `DROPPED.md`.

---

## 8. CONTRACT CHANGE POLICY (this is what makes it scale)

- Additive, optional → patch. Just edit `contract.md`.
- Removing/renaming/changing meaning of anything in `contract.md` → **breaking**.
  1. Bump `version`.
  2. List affected consumers from `depends_on` reverse lookup.
  3. Keep the old shape marked `@deprecated since <date>, remove after <date>`
     for at least one release. Never delete in the same change that replaces.
  4. Say the consumer list out loud to the user before applying.
- A unit is **never** allowed to reach into another unit's tables or internals.
  Cross-unit access goes through `contract.md` only. Violating this is a bug
  report, not a shortcut.

## 9. UNCERTAINTY POLICY

Two allowed responses to missing information, no third:

- **BLOCKING** (affects data model, money, auth, tenancy, or anything
  irreversible) → write to `open-questions.md`, ask the user, do not proceed.
- **NON-BLOCKING** → proceed with a default, tagged inline exactly as:
  `ASSUMED(2026-09-03): retries default to 3.`
  and one line in `open-questions.md`.

`open-questions.md` entries must have: date, question, blocking yes/no, and an
exit path (→ becomes a rule, or → becomes an ADR). An entry with no date is
invalid. Entries older than 30 days must be raised proactively.

## 10. SPLITTING RULES (how depth grows instead of files)

- `INDEX.md` ≤ 40 lines, always. It is a router, never content.
- `contract.md` > ~200 lines **or** covering two audiences → split into
  sub-units (`payments/refunds/`, `payments/subscriptions/`), each a full unit
  with its own front matter. Parent keeps only the INDEX.
- Split on **cohesion**, not line count: if two halves have different consumers
  or different invariants, they are two units.
- >12 top-level units → group them into bounded contexts
  (`domains/commerce/{catalog,pricing,checkout}`) and give the group an INDEX.

## 11. HARD RULES

- Add a field, table, endpoint, or dependency **only** when explicitly requested
  or structurally inseparable from the request.
- Never restructure §1 layout.
- Never rename an `id`.
- Never write a doc fact that duplicates code — link instead.
- Never mark work complete while an invariant is violated or a blocking question
  is open.
- Prefer deleting a stale doc over keeping a wrong one.
