---
id: protocol
status: fixed
version: 2.4
updated: 2026-09-04
---

# DOCS PROTOCOL v2.4 — fixed file. Copy verbatim into every project. Never edit without explicit user request.

> **v2 adds the feature-catalog layer.** New: `/features` in §1, tier 1b in §3,
> and `MODE: INGEST` (§6d). Everything from v1 is unchanged.
>
> **v2.4 adds `CONVENTIONS.md`** — house style with `C-nn` ids, in §1, tier 4
> and §11. It changes no existing rule.
>
> **v2.3 adds MODE: SYNC (§6f)** — the cheap incremental path back from code
> written without an agent. It changes no existing rule.
>
> **v2.2 adds the session boundary.** New: `HANDOFF.md` in §1 and `MODE:
> HANDOFF` / `MODE: RESUME` (§6e). It changes no existing rule.
>
> **v2.1 adds the addressing layer.** New: `SURFACES.md` and `CODE-LAYOUT.md` in
> §1, and §3b (LOCATE) — the step that turns a human sentence into a path. It
> changes no existing rule; it removes the reason an agent would ever grep.

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
  SURFACES.md           user-visible thing -> unit -> file. entry point for a vague request.
  CODE-LAYOUT.md        the mirror rule: unit id = folder name. paths are derived.
  CONVENTIONS.md        house style. how code is written, not what it does.
  BACKLOG.md            one row per shippable feature. what is built vs not.
  HANDOFF.md            mid-item session state. overwritten, never appended.
  .sync                 last commit at which docs and code agreed. see §6f.
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
| 0b | `python3 tools/where.py "<request>"` | the request names a thing, not a unit — see §3b |
| 1b | `python3 tools/spec.py <F-id>` | the backlog row names a `spec ref` |
| 2 | target `contract.md` + `invariants.md` | changing or using the unit |
| 3 | `contract.md` of each `depends_on` — **the API section only** | writing code |
| 4 | `CONVENTIONS.md`, `rules.md`, `data-model.md` | writing code *inside* that unit |
| 5 | actual source files under `source:` | implementing |

## 3b. LOCATE (run before tier 0, whenever the request has no path in it)

A request normally names a thing, not a location: *"edit the profile button in
the panel"*. Resolving that by grepping is forbidden — a repo-wide grep is the
most common way `features/App-Features.md` gets opened by accident.

```bash
python3 tools/where.py "<the user's words, verbatim>"
```

It returns one of three things, and the difference is not cosmetic:

- **confident match** — state the unit, the files and the spec id in one line,
  then continue at tier 1 for that unit only.
- **candidates** — name them and **ask**. One question is cheaper than one file
  edited confidently in the wrong place.
- **nothing matches** — the surface is not in `SURFACES.md`. Ask the user to
  point at it once, add the row with their exact words as `aliases`, continue.

Whenever a query missed and the user had to rephrase, add the failed phrasing to
that row's `aliases` **in the same turn as the fix**. That single habit is the
entire maintenance cost of this layer, and skipping it is how the map rots.

Paths are derived, never memorised: a unit id is a folder name
(`docs/CODE-LAYOUT.md`). Never invent a path that `where.py`, `source:` or the
mirror rule did not produce.

---

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
6. New user-visible surface, or a moved component file? → update
   `SURFACES.md` in the same change. A surface with no row is unaddressable, and
   the next session will grep for it.

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
7. **Stop.** One item per session. If the session filled up before the item
   was finished, do not force it to a close — run MODE: HANDOFF (§6e). Report: what shipped, what is now unblocked,
   what needs a decision from the user.

Never mark an item `done` if a blocking open question is open, an invariant is
violated, or the code was not actually written. `done` means code exists.
Half-finished work stays `doing` with a note — never silently `done`.

## 6f. MODE: SYNC (code was written without an agent)

MODE: RECONCILE re-derives the whole tree and costs a session. That is the right
tool once, when adopting the skeleton. It is the wrong tool for "I coded for a
week." SYNC is the incremental version: `tools/drift.py` diffs the code against
`docs/.sync` and produces a small, exact work order.

```bash
python3 tools/drift.py --init          # once, at a point where docs and code agree
python3 tools/drift.py                 # after coding: what changed and who owns it
python3 tools/drift.py --update-marker # only after the docs are actually fixed
```

Work the report in its own order — it is sorted by what invalidates what:

1. **Ambiguous ownership.** A `source:` glob that does not contain its unit id
   breaks the mirror rule, silently swallows other units' code, and hides every
   orphan inside itself. Nothing below it can be trusted until it is narrowed.
2. **Orphans** — code no unit claims. Each is either a new unit or belongs in an
   existing one. **Ask.** Unit boundaries are the most expensive thing in this
   repo to get wrong, and a week-old folder is not evidence of intent.
3. **Broken references** — `source:` and `SURFACES.md` paths that no longer
   resolve. Mechanical; fix them.
4. **Likely new surfaces** — propose rows, show them, then write them.
5. **Spec ids cited in commits** — verify against the code before flipping a
   backlog row. A commit message is a claim, not proof.

The limit of this mode, stated plainly: `drift.py` sees **what changed**, never
**why**. It cannot tell a domain unit from a platform one, and it cannot read an
invariant out of an implementation — what code does is not what it must do.
Documenting an inference as fact is worse than leaving a gap, because the next
session will treat it as authority (§0). Where intent is unclear: ask, or write
it into `open-questions.md`.

Never run `--update-marker` on the user's behalf. The marker asserts that docs
and code agree; only they can confirm that.

## 6e. MODE: HANDOFF / RESUME (crossing a session boundary mid-item)

`BACKLOG.md` + `MASTER_INDEX.md` are the complete resume state **between**
items. They are not enough **inside** one: a half-written service, three things
already tried and failed, and two decisions made out loud all die with the
session. `HANDOFF.md` carries exactly that and nothing else.

**Stop early, on purpose.** A session degrades before it ends: it starts
re-reading files it already has, restating what it just said, or proposing
changes to code it wrote twenty minutes ago. Those are the signals to hand off.
A handoff written while thinking is still clear is worth more than one squeezed
out of a session that has already lost the thread.

### MODE: HANDOFF

1. Stop. Write no new code. Finish nothing, start nothing.
2. Backlog row → `doing` with an honest note. **Never `done`** unless the code
   exists and is reachable.
3. Update the unit's `source:` and `status` if files were added.
4. Overwrite `HANDOFF.md`: `status: active`, `item:` = the backlog id, and every
   section filled per the instructions in that file.
5. Run `tools/backlog.py` and `tools/where.py --check`; report the output.

Record **only** what a fresh session cannot recover from the backlog, the unit
docs, `spec.py` and the code itself. Do not summarise the conversation. The two
sections that justify the file are *dead ends* (otherwise the next session
rediscovers your walls) and *decided in conversation* (otherwise project
knowledge stays in a chat log and is lost).

### MODE: RESUME

1. Read **only** `MASTER_INDEX.md`, `BACKLOG.md`, `HANDOFF.md`.
2. `status: empty` → there is no mid-flight work; run MODE: NEXT instead.
3. Confirm the handoff's `item` is still a `doing` row. If not, the handoff is
   stale: say so and stop. Do not guess.
4. Verify the *files touched* table against the disk before trusting it — the
   previous session may have been cut off mid-write.
5. Announce your reading of the state and the one next step before working. If
   it disagrees with the handoff, say so and ask.
6. Never retry anything in the *dead ends* table.

When the item lands `done`: write every *decided in conversation* row into its
real home (ADR, invariant, catalog row), then reset `HANDOFF.md` to
`status: empty`. **A handoff that outlives its item is worse than none** — the
next session will trust it. `tools/backlog.py` fails on a stale one.

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
python3 tools/where.py --check         # every surface resolves to a real file
```

A green audit means: no unit lies about being implemented, no backlog row cites
a catalog id that does not exist, no catalog feature is silently missing from
both the backlog and `DROPPED.md`, and no surface points at a file that has been
moved or deleted.

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
- Never violate a `docs/CONVENTIONS.md` rule to make something work. If a
  convention blocks the task, say which id and why, and ask — do not route
  around it quietly.
- Never grep the repo to locate a feature. Use `tools/where.py` (§3b).
- Never write a path that `where.py`, `source:` or the mirror rule did not give
  you. A plausible-looking filename is not evidence.
- Prefer deleting a stale doc over keeping a wrong one.
