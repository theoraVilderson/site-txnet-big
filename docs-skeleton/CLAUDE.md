# Project rules for AI agents

**Before any task, read `docs/00-PROTOCOL.md` and follow it.** It defines the
authority order, the tiered read protocol (token budget), and the modes:
BOOTSTRAP / EXTEND / IMPLEMENT / AUDIT / NEXT (§6b, delivery loop) /
RECONCILE (§6c, sync the backlog to existing code) / INGEST (§6d, feature
catalog -> backlog).

Start every task with `docs/MASTER_INDEX.md` (+ `docs/BACKLOG.md` for MODE: NEXT).
Never read the whole `docs/` tree.

## The feature catalog — read this part twice

`docs/features/App-Features.md` is the product spec. It is thousands of lines.

- **Never open it.** Not with Read, not with grep, not "just to check".
- A backlog row's `spec ref` is a feature **id**. Resolve it with
  `python3 tools/spec.py <F-id>` — that prints exactly the block you need.
- `docs/features/MANIFEST.md` is the only index you may scan.
- Never write a line number into any doc. Ids are the only stable address.
- Never renumber a catalog id. It is cited by backlog rows, commits and ADRs.

Opening the catalog is the single most expensive mistake available in this repo.

## What this repo is

<one paragraph: what the product is, who it serves, the one thing that makes it
different. Then the top-level layout — one line per top-level directory.>

## Project-specific additions (safe to edit; the two fixed files are not)

`docs/00-PROTOCOL.md` and `docs/FEATURES-FORMAT.md` are fixed. Everything below
is yours.

- Language: technical docs, code, commit messages, logs -> English.
- Commits: conventional commits (`feat(identity): ...`). Scope = unit `id`.
  Reference the catalog id in the body: `spec: F-0705`.
- <money / time / id / error-handling conventions>
- <anything an agent would otherwise get wrong twice>

## Before declaring any work done

```bash
python3 tools/docs-check.py
python3 tools/backlog.py
python3 tools/features-scan.py --check
```

All three must pass. `done` in the backlog means **code exists and is
reachable** — not documented, not planned. Half-finished work stays `doing`
with a note, never silently `done`.

`docs/BACKLOG.md` + `docs/MASTER_INDEX.md` are the complete resume state. A
fresh session should need nothing else to continue.
