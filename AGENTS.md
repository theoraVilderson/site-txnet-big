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
  Reference the catalog id in the body: `spec: F-105`.
- Delivery loop: MODE: INGEST pulls **one area** of the catalog into the backlog
  the day you start building it (`python3 tools/spec.py --todo` shows what is
  left); `/next` (MODE: NEXT) then ships one backlog item per session.
  `/reconcile` (MODE: RECONCILE) rebuilds the backlog from existing code — it
  has already been run once.
- Never ingest the whole catalog at once. An area you are not building costs
  nothing; ingesting it early fills the backlog with rows nobody can start.
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

All six must pass. For a change that touched TypeScript, so must
`npx tsc -p auth-service/tsconfig.spec.json --noEmit` from `txnet-backend/` —
jest transpiles without type-checking (`docs/CODE-LAYOUT.md`), so this is the
only thing that type-checks the specs. `done` in the backlog means **code exists and is
reachable** — not documented, not planned. Half-finished work stays `doing`
with a note, never silently `done`.

`docs/BACKLOG.md` + `docs/MASTER_INDEX.md` are the complete resume state
**between** items. For work stopped **mid**-item, `docs/HANDOFF.md` carries the
rest — see §6e. Stop and hand off early, while your reading of the problem is
still clear; a session that has started re-reading its own files has already
lost the thread.

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