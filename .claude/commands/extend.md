---
description: Add a feature through the protocol
---
Read `docs/00-PROTOCOL.md` and run MODE: EXTEND for: $ARGUMENTS

If that description names a thing rather than a unit, resolve it first with
`python3 tools/where.py "$ARGUMENTS"` (§3b). Never grep for it.

Before editing anything, tell me the classification (existing unit / new unit /
cross-unit) and the blast radius. If this is a new product capability rather than
a change to an existing one, it belongs in `docs/features/App-Features.md` first
— say so instead of writing code.
