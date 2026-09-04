---
description: Pick up mid-item work left by a previous session
---
Read **only** `docs/MASTER_INDEX.md`, `docs/BACKLOG.md` and `docs/HANDOFF.md`.
Nothing else yet.

If `docs/HANDOFF.md` has `status: empty`, there is no mid-flight work — run
MODE: NEXT (`/next`) instead.

Otherwise:

1. Confirm the handoff's `item` still matches a `doing` row in the backlog. If
   it does not, the handoff is stale — say so and stop rather than guessing.
2. Read the handoff in full, then tier 1–5 for its unit only, plus
   `python3 tools/spec.py <spec ref>`. Never open the catalog file.
3. Verify the *files touched* table against what is actually on disk before
   trusting it. The previous session may have been cut off mid-write.
4. **Announce before working:** what you believe the state is, and the one next
   step you are taking. If your reading disagrees with the handoff, say so and
   ask.
5. Do not retry anything in the *dead ends* table.
6. Continue per MODE: IMPLEMENT until the item is done or the session is full.

When the item lands `done`: write out every row of *decided in conversation*
into its proper home, then reset `docs/HANDOFF.md` to `status: empty` and clear
its sections. A handoff that outlives its item will mislead the next session.
