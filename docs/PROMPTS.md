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

## Pointing at things

**The normal way to ask for a change** — no paths, ever
> The profile button in the panel opens the wrong modal. Fix it.

The agent runs `python3 tools/where.py` on your sentence first, announces the
unit and the file, and then works. If it announces the wrong thing, say so
before it starts — that is what the announcement is for.

**Look something up yourself**
> ```
> python3 tools/where.py "wallet topup form"
> python3 tools/where.py "refund" --json
> ```

**When it could not find your thing**
> Add a row to `docs/SURFACES.md` for <thing>, with the exact words I used as
> aliases. Then continue.

**Register the surfaces of an existing UI** — once, early
> Read `docs/SURFACES.md` for the format, then list the routes and top-level
> components under `code_roots:`. Propose one surface row per screen and per
> control that would ever be edited on its own. Aliases in the words a user
> would say, not the component name. Output the table only — write nothing yet.

---

## Building

**The delivery loop — this is the "just keep going" prompt**
> Run MODE: NEXT.

Repeat it. Each run picks the next unblocked item, implements it, updates the
backlog, and stops. A fresh session needs no other context.

## House style

**Teach it a rule you already follow in code**
> We already do this in `apps/api/src/modules/billing/`: anything that can throw
> goes through `safeExecute()` instead of a raw try/catch. Read that code, then
> add it to `docs/CONVENTIONS.md` as a new `C-nn` with the rule, the reason, a
> right/wrong example, and a `check` block. Show me the block before writing it.

Point at **real code** rather than describing the rule in the abstract. The
agent reads your actual usage and writes a convention that matches what you do,
instead of a plausible-sounding version of it.

**Add several at once**
> Here is our house style: <list them>. Put each in `docs/CONVENTIONS.md` with an
> id. For each one, tell me honestly whether it can be checked by a regex — if
> not, mark it `review` rather than writing a check that half-works.

**Find out what is actually enforced**
> ```
> python3 tools/conventions.py --list
> python3 tools/conventions.py
> ```

**When a rule keeps getting broken**
> C-02 was violated again. Do not just restate it — move it up the enforcement
> table. Write a `check` block, or an ESLint rule if the pattern needs the AST.

---

**You coded for a week without an agent — catch the docs up**
> ```
> /sync
> ```

Prerequisite, run once at a point where docs and code agree:
> ```
> python3 tools/drift.py --init
> ```

Then, whenever you come back after coding alone, `/sync` gives the agent an
exact work order instead of letting it re-read the tree. Expect it to **ask**
about orphaned code rather than inventing units — that is correct behaviour, not
reluctance. When the docs are actually fixed, you (not the agent) run
`python3 tools/drift.py --update-marker`.

**Habits that make this cheap** — worth doing even with no agent in the loop:
> - one commit per logical change, scope = unit id: `feat(billing): ...`
> - cite the catalog id in the body: `spec: F-0207`
> - keep new code inside `<root>/<unit-id>/` so the mirror rule holds

None of these are required. Each one removes a question you would otherwise
have to answer from memory a week later.

**The session is filling up mid-feature — stop cleanly**
> ```
> /handoff
> ```

Do this **before** the session degrades, not after. The tell is when it starts
re-reading files it already has, restating itself, or second-guessing code it
wrote twenty minutes ago. Nothing is lost by handing off early; a lot is lost by
handing off late.

**Start the next session**
> ```
> /resume
> ```

Reads `MASTER_INDEX.md`, `BACKLOG.md` and `HANDOFF.md` only, states what it
believes the state is, and continues. If the handoff is stale it stops and says
so instead of guessing.

**When the item finally lands**
> The item is done. Write every row of *decided in conversation* into its real
> home — ADR, invariant, or catalog row — then reset `docs/HANDOFF.md` to
> `status: empty`.

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

**Check the addressing layer still points at real files**
> ```
> python3 tools/where.py --check
> ```

**Check progress**
> ```
> python3 tools/backlog.py
> python3 tools/features-scan.py --check
> ```

**Migrate an old pile of markdown into this skeleton**
> See `docs/MIGRATION.md`. Phase 0 first — it costs seconds and makes every
> later phase cheap.
