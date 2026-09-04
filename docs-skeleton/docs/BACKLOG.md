---
id: backlog
status: active
updated: YYYY-MM-DD
---

# Backlog

The single source of truth for **what is built and what is not**. One row per
shippable feature. Read together with `MASTER_INDEX.md` at the start of every
MODE: NEXT session — these two files are the entire resume state.

`status`: `todo` | `doing` | `done` | `blocked` | `dropped`
`done` means code exists and is reachable. Not "documented", not "planned".

`spec ref` is the **feature catalog id** (`F-0705`), never a line range — line
numbers shift on the first catalog edit. Resolve it with:

```bash
python3 tools/spec.py F-0705
```

Rows come from two places: MODE: RECONCILE (found in existing code) and
MODE: INGEST (pulled from `features/App-Features.md`, one area at a time).

| id | feature | unit | status | depends_on | spec ref | proof (code path) | note |
|---|---|---|---|---|---|---|---|
| _F-0001_ | _example: OTP login over SMS_ | _identity_ | _done_ | _—_ | _F-0203_ | _src/auth/otp.service.ts_ | _delete this row_ |

## Rules
- Never delete a row. Move it to `dropped` with a reason in `note`.
- An item too big to finish in one session must be split into sub-items first.
- `blocked` requires the blocker named in `note` and a matching entry in the
  unit's `open-questions.md`.
- Ids are permanent. Never renumber.
- A row whose `spec ref` is not in the catalog fails
  `python3 tools/features-scan.py --check`. Fix the row, never the catalog.

## Decisions needed from the user
Items flagged `needs-decision` — the loop will not touch these until answered.
Anything affecting the data model, money, auth, tenancy, or anything
irreversible belongs here rather than in an `ASSUMED(...)` tag.

| id | question | asked on |
|---|---|---|
| _D-1_ | _example: system base currency and its decimal places_ | _YYYY-MM-DD_ |
