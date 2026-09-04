---
description: End the session mid-item and write the state the next session needs
---
Stop working now. Write no new code, start nothing, finish nothing.

1. Update the current item's row in `docs/BACKLOG.md` to `doing`, with a short
   honest note. **Never `done`** unless the code is actually written and
   reachable.
2. Update the unit's `source:` paths and `status` if files were added.
3. Overwrite `docs/HANDOFF.md`. Set `status: active` and `item:` to the backlog
   id. Fill every section per the instructions inside that file.
4. Run `python3 tools/backlog.py` and `python3 tools/where.py --check`, and
   report their output.

Rules for the handoff itself:

- **Do not summarise this conversation.** Record only what a fresh session
  cannot recover from the backlog, the unit docs, `spec.py` and the code.
- The *dead ends* table and the *decided in conversation* table are the point.
  Without them the next session repeats your failures and loses your decisions.
- Be specific about file states. "in progress" is useless; "the transaction
  wrapper is missing from debit()" is what the next session needs.
- If anything was decided verbally that belongs in an ADR, an invariant or a
  catalog row, say so explicitly in the last table rather than writing it in
  from memory now.

Then report, in five lines or fewer: what works, what is half-done, what the
next step is. Do not continue after that.
