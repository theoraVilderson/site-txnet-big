---
description: Resolve a vague description ("the profile button in the panel") to unit, doc and code path
---
Run `python3 tools/where.py "$ARGUMENTS"` first, before reading anything else.

Then:
- **confident match** -> announce the unit, the file(s) you will touch and the
  spec id in one line, then proceed with MODE: IMPLEMENT (`docs/00-PROTOCOL.md` §6).
- **candidates** -> name them to the user and ask which one. Do not guess a path.
- **nothing matches** -> the surface is missing from `docs/SURFACES.md`. Ask the
  user to point at it once, add the row (with aliases in their own words), then
  continue. Never open `docs/features/App-Features.md` to go looking.

Read only Tier 1-5 for the resolved unit. When the work is done, if the query
had to be repeated or rephrased to find the thing, add the phrasing that failed
to that row's `aliases` column.
