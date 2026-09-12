# Project rules for AI agents

**Canonical file.** Every agent reads this one. Tool-specific files
(`CLAUDE.md`, `.cursor/rules/`, `.github/copilot-instructions.md`, `GEMINI.md`)
must *point* here, never duplicate it — see `docs/AGENT-SETUP.md`.

**Before any task, read `docs/00-PROTOCOL.md` and follow it.** It defines the
authority order, the tiered read protocol (token budget), and the modes:
BOOTSTRAP / EXTEND / IMPLEMENT / AUDIT / NEXT (§6b, delivery loop) /
RECONCILE (§6c, sync the backlog to existing code) / INGEST (§6d, feature
catalog -> backlog) / HANDOFF & RESUME (§6e, session boundary) /
SYNC (§6f, catch docs up to code written without an agent) /
DIAGNOSE (§6g, something is broken).

**v2.8 note.** The protocol now caps writing as well as reading — doc files per
item, changelog rows, tests, ADRs — and requires a call-site listing before any
signature change (§6.2b). See "What v2.8 caps" below before your first session.

Start every task with `docs/MASTER_INDEX.md` (+ `docs/BACKLOG.md` for MODE: NEXT).
Never read the whole `docs/` tree.

## The feature catalog — read this part twice

`docs/features/App-Features.md` is the product spec: 1894 lines, 169 features.

- **Never open it.** Not with Read, not with grep, not "just to check".
- A backlog row's `spec ref` is a feature **id**. Resolve it with
  `python3 tools/spec.py <F-id>` — that prints exactly the block you need.
- `docs/features/MANIFEST.md` is the only index you may scan.
- Never write a line number into any doc. Ids are the only stable address.
- Never renumber a catalog id. It is cited by backlog rows, commits and ADRs.
- `docs/FEATURES-FORMAT.md` is the contract the catalog satisfies — fixed file.

Opening the catalog is the single most expensive mistake available in this repo.

## Addressing — the user never gives you a path

Assume every request arrives as a human sentence with no path in it: *"the
register form on the landing site is broken"*, *"the profile button in the
panel opens the wrong thing"*. That is the normal case, not a badly-written
request.

**First command of any such task, before reading anything:**

```bash
python3 tools/where.py "<the user's words, verbatim>"
```

Pass the sentence as they typed it. The tool matches it against
`docs/SURFACES.md` aliases, unit `keywords:`, `MASTER_INDEX.md`, the backlog and
the feature manifest, then falls back to filenames under `code_roots:`.

| result | what to do |
|---|---|
| `confident match` | announce unit + files + spec id in one line, then MODE: IMPLEMENT (§6) |
| `candidates` | name them to the user and ask which. **Never pick one silently.** |
| `nothing matches` | the surface has no row. It is logged to `docs/.where-misses`; ask the user to point at it once, add the `SURFACES.md` row using their exact words as aliases, then continue |
| `walk plan` | the request named a symptom, not a place — follow §3c and MODE: DIAGNOSE (§6g), below |

## When something is broken

A bug report names a symptom, not a place: *"cookie login doesn't work"*,
*"لاگین کوکی کار نمیکنه"*. Do not treat it as a search problem:

```bash
python3 tools/where.py --walk "<the user's words, verbatim>"
```

The tool separates *where they saw it* from *what they think caused it*, and
returns an ordered path through units (`panel-web -> auth-api -> redis-keyspace`)
instead of a shortlist of rivals. Then:

- **Say what you expect to find before opening each hop.** One line. A hop you
  cannot predict is a hop you are not ready to take.
- **Budget: 3 hops, 8 files.** Inside a unit, pick the file with the
  symptom -> role table in `docs/CODE-LAYOUT.md` — this repo is polyglot, so that
  table, not a guess, says whether the answer is in Go, Nest or Next.
- **Never create a unit mid-walk.** Report code no unit claims and leave it;
  that call belongs to MODE: SYNC (§6f), with the user.
- **When it is fixed, write the path down.** A `## Flows` row in `SURFACES.md`
  with the user's own sentence as aliases, then
  `python3 tools/where.py --resolve "<their sentence>"`. The second report of the
  same bug then costs one command instead of a walk.

Hard rules:

- Never `grep -r` the repo to find a feature. That is what `where.py` is for,
  and a blind grep is how the catalog gets opened by accident.
- Never guess a path from a filename that looks plausible. A wrong file edited
  confidently costs far more than one clarifying question.
- If the user had to rephrase to be understood, that phrasing is missing from
  the `aliases` column. **Add it in the same turn as the fix**, before reporting
  done. This is the only maintenance the addressing layer needs, and skipping it
  is exactly how such maps rot.
- A new user-visible surface means a new `SURFACES.md` row in the same change
  that builds it.

Code paths are derivable, not remembered — see `docs/CODE-LAYOUT.md`. This repo
is a polyglot monorepo (Nx/NestJS, Go, two Next.js apps), so unlike a single
`apps/api` tree, a unit's `source:` globs are the authoritative path, not a
single fixed root — `docs/CODE-LAYOUT.md` lists the roots.

## Starting a backlog item — one command before the first read

The tiered read protocol narrows to a *unit* and stops there. Between "the row
says `panel-web`" and "these four files govern this row" sits a search that
every session pays again: open the unit's INDEX router, read its `Files` table,
guess which `contract.<topic>.md` applies, find the dependency row's contract the
same way, then look up the legacy files and the conventions. That is eight reads
to learn something the repo already knows.

```bash
python3 tools/brief.py <backlog-id>      # or --next for the first eligible row
```

It prints, in well under a second: the row and whether it is actually eligible
(per dependency, so a blocked row names its blocker); the legacy files that row
is allowed to open; **every doc file that names this row or one of its
dependencies**, which is how a `contract.<topic>.md` says what it governs; the
dependency units' contract files for tier 3; the `C-nn` ids that bind this
unit's code, split by whether anything actually fails on a violation; the test
budget and the narrowed commands for the right stack; and §6b itself — 25 lines
of a 687-line fixed file, instead of all of it.

It reads no source and decides nothing. Every path it names is still read by
you; what it removes is the hunting, and the re-reading of three cross-cutting
files whose relevant slice for one row is a few dozen lines out of 1275. Use
`-q` to get the paths alone when you already know the shape of the work.

**It is a funnel, not a substitute for reading.** A session that acts on the
briefing's one-line summaries without opening the contracts will get the rules
wrong, and the briefing cannot tell you that it did.

## The reading pattern — how to read the files, once you know which

`brief.py` answers *which* files. This answers *how*, and it is where a session's
budget is actually won or lost. Every number below was measured in this repo on
2026-09-12: a rule with a number beside it gets followed, and one without it does
not.

**1. Measure before optimising.** The six checks under "Before declaring any work
done" total **5.5s**. They are not the slow part and never were — reading is, and
it is most of a session's cost before the first line of code. Time the thing you
are about to speed up, or you will speed up the wrong thing.

**2. `grep`/`sed` the file; do not `cat` it.** The difference is not marginal:

| instead of | do this | cost |
|---|---|---|
| reading `docs/BACKLOG.md` (270 KB, ~67k tokens) | `grep -n "<row-id>" docs/BACKLOG.md` | ~600 tokens — **100x less** |
| reading a `contract.*.md` for one fact | `grep -n "channel\|event" <file>` | ~400 vs ~2,800 |
| reading a long source file | `sed -n '1,150p'`, or `grep -n "export \|interface "` first | a quarter of it |

A whole-file read is right when you will use most of the file — a unit's
`contract.md`, a component you are about to change. It is wrong for anything
tabular, indexed or long, which is most of `docs/`.

**3. Batch independent reads into one message.** Three `Bash` calls in one block,
not three turns. Nothing about the work changes; the round trips go away.

**4. Never read `BACKLOG.md` whole.** §6b.1 says to, and `brief.py --next` makes
it unnecessary — the row, its eligibility and its inputs for ~600 tokens instead
of ~67,000. It is 203 rows and grows every session, so this is the largest single
saving available and it costs nothing.

**5. Surface an architectural decision the moment you find it.** Mid-item it is
one question; end-of-item it is a rebuild. See "Decide once" below: ADR-0015 is
the worked example of getting this wrong, and F-093-c (the CORS path, 2026-09-12)
of getting it right — one question, and five later rows inherited the answer.

**6. List the call sites before changing a signature** (§6.2b — cheap enough to
be unconditional). One `grep -rn` on `request()` found 24 call sites, all inside
one file, and that is what chose the safe refactor: keep the signature, delegate
the body, touch no caller.

**7. Prove a refactor with the existing suite before building on it.** Extract,
then immediately run the tests that already cover it — `auth-api.test.ts` is 29
tests in 10s. The same red answer five files later costs an hour to localise.

**8. Write the spec first and watch it fail for the reason you named.** Required
already by `docs/CODE-LAYOUT.md` "Order of work", and repeated here because it is
a speed rule as much as a correctness one: code written against a failing target
is faster than code you go back and test.

**9. Ask how much room a doc has before writing prose into it, not after.**
`docs-check.py` caps a contract at 250 lines and an INDEX body at 40, and the
cap is checked at the end — so a finished 290-line contract turns into a dozen
rounds of trim-and-recount, each one a chance to cut a decision instead of a
word. One command, and it counts exactly the way the checker counts:

```bash
python3 tools/docs-check.py --room docs/domains/<unit>/contract.<topic>.md
```

With no paths it lists every capped file with under 20 lines left — which is
most of them, because this is a mature docs tree. **If the room is less than
what you are about to write, that is the signal to open a
`contract.<topic>.md`, not to write small.** Deciding that first costs one
command; deciding it after costs the dozen rounds *and* leaves compressed prose
behind. Measured 2026-09-12 on F-0606-a, which is where the dozen rounds went.

**Where this still leaks:** one session read ~74 KB of `00-PROTOCOL.md`,
`CODE-LAYOUT.md` and `CONVENTIONS.md` whole where a slice would have done.
`brief.py` prints §6b and the `C-nn` ids in play; it does not yet print the
contract rule sections, and until it does that read is yours to narrow by hand.

**Is any of it working?** `python3 tools/cost.py` prints the fixed read tax and
its trend from git. Run it when a session feels slow, and before proposing a fix
to make it faster.

## Code written without an agent

If the user has been coding on their own, the docs are behind. Do not guess at
the gap and do not re-read the tree:

```bash
python3 tools/drift.py
```

It reports what changed since `docs/.sync` and who owns it. Then follow MODE:
SYNC (§6f). Two rules matter more than the rest: **ask** before creating a unit
for orphaned code, and never document an inference as fact — what an
implementation does is not what it must do.

## What this repo is

TXNet — a multi-tenant, white-label reseller platform for VPN/digital services.
One platform owner + many resellers (tenants), each with their own branding,
domain, pricing, payment gateway and bot. See `docs/architecture/overview.md`.

The repo is a polyglot monorepo:

- `txnet-backend/` — Nx workspace, NestJS services (`auth-service` live,
  `billing-service` scaffold) + the Prisma schema (`prisma/domains/*.prisma`,
  Postgres `multiSchema`, one schema per business domain).
- `auth-handler/` — Go Traefik ForwardAuth gateway (JWT + Redis session + RBAC).
- `i18n-platform/` — `locale-service` (Go gRPC, source of truth for every
  translation) + one shared Go client and one shared Node client.
- `locales/` — the translation content `locale-service` serves.
- `site-pwa/` — Next.js user panel. `coinsite/` — Next.js landing site (skeleton).
- `dev-docker/`, `swarm/`, `scripts/` — Traefik + Postgres + Redis + RabbitMQ +
  monitoring; `docker compose` for dev, Docker Swarm for prod.

Most Prisma domains are **schema only** — no service implements them yet. Those
units are `status: draft` with `source: []`. Do not describe unbuilt behaviour as
if it exists.

## Project-specific additions (safe to edit; the two fixed files are not)

`docs/00-PROTOCOL.md` and `docs/FEATURES-FORMAT.md` are fixed. Everything below
is yours.

- Commits: conventional commits (`feat(identity): ...`). Scope = unit `id`.
  Reference the catalog id in the body: `spec: F-105`. A finished backlog item
  is committed without asking — see "When an item is done, commit it" below.
- Delivery loop: MODE: INGEST pulls **one area** of the catalog into the backlog
  the day you start building it (`python3 tools/spec.py --todo` shows what is
  left); `/next` (MODE: NEXT) then ships one backlog item per session.
  `/reconcile` (MODE: RECONCILE) rebuilds the backlog from existing code — it
  has already been run once.
- Never ingest the whole catalog at once. An area you are not building costs
  nothing; ingesting it early fills the backlog with rows nobody can start.
- `docs/legacy/txnetsite-perv/` is the previous app, kept only to port from
  (`F-092-*` / `F-093-*`). Open only the files its `README.md` names for your
  row — never the folder whole, never `txnetsite-perv.zip`.
- Tests come before the code they cover, and the e2e tier is never run
  unasked. Both rules live with the rest of the test policy in
  `docs/CODE-LAYOUT.md` ("Order of work" and "Running them without burning the
  session") — read them there before writing an item's first line.

## Decide once

§6b.3 asks for an announcement before working and §6.2 for five lines of plan.
That is the whole planning budget. Do not re-derive the plan mid-task, do not
re-open a file already in context (§3), and do not re-verify a decision the user
has already approved. New evidence that contradicts the plan is a different
thing: say so in one line and change course.

**If the task turns out to need an architectural change that was not in the
plan, stop and say so before building it.** One line — *"this works as asked,
but only if X changes; X is a separate decision. Now, or a row of its own?"*
Discovering the change is good work. Absorbing it silently into the same session
is what turns a small feature into a long one, and after opening the catalog it
is the most expensive habit available here. ADR-0015 is the worked example: a
re-architecture found while implementing one small feature, and built in the
same session rather than raised.

## What v2.8 caps, and why you will notice

`00-PROTOCOL.md` v2.8 added ceilings on **writing** to match the ones that
already existed on reading. Four of them change how a normal session ends:

- **At most 3 unit doc files per backlog item** (§11). Further units get
  `source:`/`status` updated and nothing else. §8 still requires the consumer
  list out loud, so a lagging contract is visible, not silent.
- **A changelog row only for a version bump, a status flip or a contract break**
  (§5.4, §6b.6). Routine work gets none; `git log --follow docs/<layer>/<unit>/`
  has it.
- **One decision written once** (§11). An ADR is the home of a *why*; a backlog
  note cites it in three lines and adds nothing.
- **A test budget** (`docs/CODE-LAYOUT.md`). One `*.spec.ts` per item; the
  integration and e2e tiers only when a `contract.md` row changes.

None of these are optional and none are worth routing around. If one blocks a
task, name it and ask — the same rule as a `CONVENTIONS.md` id.

## House style

`docs/CONVENTIONS.md` holds every rule about *how* code is written, each with a
permanent id (`C-nn`) — language, money representation, Redis key building.
Read it at tier 4, before writing code inside any unit. Cite the id when a
review comment or a commit turns on one.

Some conventions are mechanically enforced; the rest rely on you reading them.
Never route around a convention to make something work — name the id, say why it
blocks you, and ask.

## Before declaring any work done

```bash
python3 tools/docs-check.py
python3 tools/backlog.py
python3 tools/features-scan.py --check
python3 tools/where.py --check
python3 tools/conventions.py
python3 tools/contracts.py
```

All six must pass. For a change that touched TypeScript, so must these two,
from `txnet-backend/`:

```bash
npm test          # nx run-many -t test — all 7 unit projects, ~80s
npm run typecheck # tsc --noEmit over all 16 tsconfigs, ~2m
```

**Start those two together — they are ~80s and ~120s, and one is vitest while
the other is `tsc`. Measured 2026-09-12: **132s** for the pair, both fully
green, against ~200s one after the other.**

```bash
cd txnet-backend && { npm test > /tmp/test.log 2>&1 & \
                      npm run typecheck > /tmp/tc.log 2>&1 & wait; }
```

Note the braces. `cd X && (A) & (B) &` binds the `cd` to the **first** subshell
only, and the second command then runs in the wrong directory and reports
`Missing script` — which reads exactly like a repo problem and is not one.

**Spend 50 seconds before that pair, not 180 after it.** Narrowing while
iterating only covers the project you are editing, so a shared file's blast
radius arrives in the end-of-item run — and a failed pair costs ~180s to learn
one thing. `grep -rln "toMatchSnapshot"` over the directories your change
reaches is **0.01s** and names every other project that enumerates what you
touched; running those specs and one `tsc -p <project>/tsconfig.spec.json` is
~40s. Measured 2026-09-12 (F-0606-a: one key added to `shared-core`, two red
snapshots in two projects that were never edited, plus a type error in the new
spec — all three found by the wasted pair). The table is in
`docs/CODE-LAYOUT.md` "Running them without burning the session".

**Do not add a third suite to that pair.** `site-pwa`'s vitest alongside the
workspace's seven projects oversubscribes the machine: ~130 files fail that pass
on their own, arriving as a wall of red that looks like a real regression. It is
the contention `docs/CODE-LAYOUT.md` warns about for the integration tier, and
the cheap way to tell the two apart is to re-run the suite on its own.

**Run both whole; do not substitute one project for the workspace.** vitest
transpiles through SWC without type-checking (`docs/CODE-LAYOUT.md`), so
`typecheck` is the only thing that checks types at all — and a
`tsconfig.spec.json` sees its spec files plus what they statically `import`,
nothing more. Until 2026-09-12 this line named one project's tsconfig and `npm
test` ran one project's specs; between them they missed 49 spec files and two
type errors that broke `billing-service`'s build. Narrow **while iterating** by
all means (`docs/CODE-LAYOUT.md` says how) — just not for the run that says
done.

`done` in the backlog means **code exists and is
reachable** — not documented, not planned. Half-finished work stays `doing`
with a note, never silently `done`.

`docs/BACKLOG.md` + `docs/MASTER_INDEX.md` are the complete resume state
**between** items. For work stopped **mid**-item, `docs/HANDOFF.md` carries the
rest — see §6e. Stop and hand off early, while your reading of the problem is
still clear; a session that has started re-reading its own files has already
lost the thread.

## When an item is done, commit it

**Standing instruction from the user (2026-09-11): a backlog item that lands
`done` is committed by the agent, in the same session, without asking.** It
replaces "commit only when asked" for this case and no other. The message format
is `docs/CODE-LAYOUT.md` "Commits".

- **When:** the row is `done` and every check in "Before declaring any work
  done" passed. A row left `doing`, a HANDOFF, a DIAGNOSE fix, or work that is
  not a backlog item is not committed unasked.
- **One commit per item.** A file holding two items' changes is split, so each
  commit carries its own item's state of that file. A `git mv` stages itself —
  check `git diff --cached` belongs to the item before committing.
- **Stage by path, never `git add -A` / `git add .`** — exactly the files the
  item touched: its proof column, the docs it changed, anything moved.
- **Message:** subject, blank line, a body that says what changed, why, and
  which tests ran with their counts (and what was *not* run), then
  `spec: <backlog id>`, then the tool's attribution trailer if it has one.
- **Never** push, amend or rewrite a commit that is not this session's own and
  local, skip hooks, or commit on a detached HEAD or mid-rebase/merge.

**Ask instead of committing — name the file and the doubt — when:**

- `git status` shows a change the item did not make (the user's own work, or an
  earlier session's), especially inside a file the item also touched;
- a file looks like a secret or local config (`.env*`, keys, credentials,
  `*.local.*`), a build output (`dist/`, `coverage/`), or a lockfile / generated
  file changed without the item meaning to;
- a hunk could belong to either of two items, or to none;
- a check failed, was skipped, or could not run;
- the branch is not the one the session started on.

A commit that is wrong is cheap to fix locally, but only if the user knows it
happened — so the report always ends with the commit hash(es) and subjects.

## If you cannot run shell commands

Some setups give you this file but no terminal and no filesystem. In that case
`spec.py` and `where.py` cannot be run by you — the user runs them and pastes
the output. Then:

- Ask for `python3 tools/where.py "<their words>"` output instead of guessing a
  path or asking them to hunt for one.
- Ask for `python3 tools/spec.py <F-id>` output instead of asking for the spec.
- **Never ask for `docs/features/App-Features.md`.** If it is offered, decline
  and ask for the `spec.py` output for the specific id.
- Output **complete files**, never diffs or fragments, and name the exact path
  for each. The user is saving them by hand; a fragment costs them a merge.
- At the end of a session, output the full text of `docs/HANDOFF.md` and the
  changed `docs/BACKLOG.md` rows so the next session can resume.