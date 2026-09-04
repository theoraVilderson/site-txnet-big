# AI-Ready Docs Skeleton v3

A documentation structure for projects an AI agent works on daily, sized for
**big, long-lived, complex** codebases where the spec is thousands of lines and
context is the scarcest resource.

v3 adds the **feature-catalog layer**: a machine-readable spec that an agent
addresses by id instead of reading.

---

## The problem it solves

A serious product spec is 1500–4000 lines. An agent that reads it on every task
burns its context on text it does not need, keeps roughly half, and invents the
rest. So the catalog is never read. It is **indexed**, and each feature is
**addressed by a permanent id**.

The cost of one feature session:

| | without this | with this |
|---|---|---|
| spec read | the whole catalog | one `###` block, ~40–120 lines |
| how it is found | scanning / guessing | `python3 tools/spec.py F-0705` |
| survives a catalog edit | no — line numbers shift | yes — ids never move |

That last row is the important one. **Nothing outside the catalog ever stores a
line number.** Backlog rows cite ids; `spec.py` re-derives the location on every
call. A catalog rewrite cannot rot a single backlog row.

---

## Install

```bash
cp -r docs-skeleton/docs   your-project/docs
cp -r docs-skeleton/tools  your-project/tools
cp    docs-skeleton/CLAUDE.md your-project/CLAUDE.md
cd your-project
python3 tools/docs-check.py        # 0 errors on a fresh skeleton
```

Then, in order:

1. Fill `docs/GLOSSARY.md` **first**. Names are the backbone — if `user`,
   `customer` and `account` are not unified now, they become three tables.
2. Write `docs/features/App-Features.md` per `docs/FEATURES-FORMAT.md`
   (hand that file plus your feature list to a model — the prompt is in §10 of it).
3. `python3 tools/features-scan.py --check` until it exits 0.
4. Fill `docs/MASTER_INDEX.md` with your units.
5. Run MODE: INGEST for the first area you will build.
6. Run MODE: NEXT, repeatedly.

---

## Layout

```
docs/
  00-PROTOCOL.md        FIXED. the rules every agent obeys. do not edit.
  FEATURES-FORMAT.md    FIXED. the contract the catalog must satisfy.
  MASTER_INDEX.md       one line per unit. entry point for every task.
  BACKLOG.md            one row per shippable feature. built vs not built.
  GLOSSARY.md           canonical names. one term = one meaning.
  PROMPTS.md            copy-paste prompts.
  MIGRATION.md          how to fold an existing pile of markdown in.

  features/             the product spec — NEVER read whole
    App-Features.md     hand-written, in FEATURES-FORMAT shape
    MANIFEST.md         GENERATED. id -> block -> line range.
    DROPPED.md          catalog ids deliberately not built, with reasons.

  domains/              business logic, owns state
  interfaces/           what the outside world touches
  platform/             cross-cutting, no business rules
  _TEMPLATE-unit/       copy this to start a unit
  architecture/         overview, tech-stack, dependency-graph, decisions/
  operations/           environments, migrations, observability
  security/             threat model

tools/
  docs-check.py         enforces the protocol mechanically
  backlog.py            progress + what is eligible next
  features-scan.py      indexes + validates the catalog
  spec.py               id -> exactly the spec text needed
  ingest-scan.py        one-off scanner for a legacy markdown corpus
```

---

## The three loops

**INGEST** — catalog → backlog, one area at a time, the day you start that area.
An area you are not building costs nothing.

**NEXT** — backlog → code, one row per session. Reads the unit's docs plus one
`spec.py` call. Stops. A fresh session with zero context resumes correctly.

**AUDIT** — proves nothing drifted: no unit lies about being implemented, no
backlog row cites a catalog id that does not exist, no catalog feature is
missing from both the backlog and `DROPPED.md`.

---

## Why it does not rot

| Rot | What stops it |
|---|---|
| docs claim a feature exists, code disagrees | `status: active` requires non-empty `source:` whose paths resolve — `docs-check.py` fails otherwise |
| spec refs break when the catalog is edited | refs are ids, never line numbers; `spec.py` re-derives |
| a feature silently disappears | `--check` coverage: every catalog id is in the backlog or in `DROPPED.md` |
| duplicated facts diverge | never duplicate what lives in code; link to it (§0 authority order) |
| the backlog fills with unstartable epics | one row = one sitting; `--check` warns on oversized blocks |
| an agent reads everything and keeps nothing | tiered read protocol, §3, with hard limits |
| a decision gets re-litigated every quarter | ADRs and catalog `C-nn` rows record what was chosen and why |

---

## Validate anytime

```bash
python3 tools/docs-check.py             # front matter, source: paths, reachability
python3 tools/backlog.py                # progress, deps, next eligible
python3 tools/features-scan.py --check  # catalog format + coverage
python3 tools/spec.py --todo            # what is not ingested yet
```

Wire the three into CI. A skeleton nobody checks is just more markdown to rot.
