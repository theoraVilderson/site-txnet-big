# Project rules for AI agents

**Canonical file.** Every agent reads this one. Tool-specific files
(`CLAUDE.md`, `.cursor/rules/`, `.github/copilot-instructions.md`, `GEMINI.md`)
must *point* here, never duplicate it — see `docs/AGENT-SETUP.md`.

**Before any task, read `docs/00-PROTOCOL.md` and follow it.** It defines the
authority order, the tiered read protocol (token budget), and the modes:
BOOTSTRAP / EXTEND / IMPLEMENT / AUDIT / NEXT (§6b, delivery loop) /
RECONCILE (§6c, sync the backlog to existing code) / INGEST (§6d, feature
catalog -> backlog) / HANDOFF & RESUME (§6e, session boundary) /
SYNC (§6f, catch docs up to code written without an agent).

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
| `nothing matches` | the surface has no row. Ask the user to point at it once, add the `SURFACES.md` row using their exact words as aliases, then continue |

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
```

All five must pass. `done` in the backlog means **code exists and is
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
