# Ready-to-use prompts

Copy-paste. Each one is a full session's instruction.

---

## Setting up

**Bootstrap a project from a description**
> Read `docs/00-PROTOCOL.md`. Run MODE: BOOTSTRAP for this project: <description,
> however incomplete>. Start with the glossary and the invariants. Do not invent
> fields or endpoints — put gaps in open-questions.md and ask me.

**Onboard an existing codebase**
> Run MODE: BOOTSTRAP, but derive units from the existing code instead of a
> description. Fill `source:` from real paths. Anything you cannot verify in code
> goes to open-questions.md, not into contract.md.

**Half-built project — run once, first**
> Read `docs/00-PROTOCOL.md`. Run MODE: RECONCILE. Report the table. Change
> nothing until I approve.

---

## The feature catalog

**Write the catalog** (hand to whichever model is drafting it)
> Read `docs/FEATURES-FORMAT.md` and follow it exactly — it is a machine
> contract, not a style guide. Write `docs/features/App-Features.md` from the
> features below. Every capability must be a table row with a permanent id;
> anything only in prose will never get built. <paste features>

**Index it**
> ```
> python3 tools/features-scan.py          # rebuild the manifest
> python3 tools/features-scan.py --check  # must exit 0
> ```

**Pull one area into the backlog** — do this the day you start building that area
> Run MODE: INGEST for section <NN>. Read the manifest and
> `python3 tools/spec.py --area <NN>` only. Report the rows before writing them.

**See what is left**
> ```
> python3 tools/spec.py --todo
> ```

---

## Building

**The delivery loop — this is the "just keep going" prompt**
> Run MODE: NEXT.

Repeat it. Each run picks the next unblocked item, implements it, updates the
backlog, and stops. A fresh session needs no other context.

**Add a feature that is not in the catalog**
> Follow MODE: EXTEND in `docs/00-PROTOCOL.md` for: <feature>. Before editing,
> tell me the classification (existing unit / new unit / cross-unit) and the
> blast radius.

**Write the code for a unit**
> Follow MODE: IMPLEMENT for unit `<id>`. State the file plan and the invariants
> in play first, then implement.

**Read one feature's spec without opening the catalog**
> ```
> python3 tools/spec.py F-0705
> ```

---

## Keeping it honest

**Health check**
> Run MODE: AUDIT. Report drift as a table. Change nothing.

**Check progress**
> ```
> python3 tools/backlog.py
> python3 tools/features-scan.py --check
> ```

**Migrate an old pile of markdown into this skeleton**
> See `docs/MIGRATION.md`. Phase 0 first — it costs seconds and makes every
> later phase cheap.
