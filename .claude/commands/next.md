---
description: Implement the next unblocked backlog item, then stop
---
Read `docs/00-PROTOCOL.md` and run MODE: NEXT.

Read only `docs/MASTER_INDEX.md` and `docs/BACKLOG.md` first. Resolve the row's
`spec ref` with `python3 tools/spec.py <F-id>` — never open the catalog directly.
Announce the item you picked before doing any work. Implement exactly one item,
update the backlog row and the unit docs, then stop and report what is now
unblocked.

If the item adds or moves a user-visible surface, add or update its
`docs/SURFACES.md` row in the same turn — otherwise the next session cannot find
it without grepping.
