---
description: Something is broken — walk the unit graph instead of reading the area
---
Run this first, before reading anything:

```bash
python3 tools/where.py --walk "$ARGUMENTS"
```

Then follow MODE: DIAGNOSE (`docs/00-PROTOCOL.md` §6g).

- **cached flow** -> the path is known. Take it, skip the walk.
- **walk plan** -> announce the entry point and the hypothesis in one line, then
  walk it. **Before each hop, say what you expect to find there.** A hop you
  cannot predict is a hop you are not ready to take — say so and stop.
- **nothing matches** -> do not guess a path. Walk from the nearest surface that
  does exist and say that is what you are doing.

Budget: 3 hops, 8 files. Inside a unit, pick the file with the symptom -> role
table in `docs/CODE-LAYOUT.md` — one file per hop, never the whole unit. A wrong
prediction is information: name it, then choose the next role deliberately.

Code no unit claims: report it, leave it. Creating a unit is MODE: SYNC's call.

When it is fixed, in the same turn:
1. a `## Flows` row in `docs/SURFACES.md` — the chain you walked, the files you
   changed, the user's sentence verbatim in `aliases`
2. `python3 tools/where.py --resolve "$ARGUMENTS"`
3. `python3 tools/where.py --check` must pass
