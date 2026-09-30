---
id: handoff
status: empty            # empty | active
item:                    # the backlog id currently mid-flight
updated: 2026-09-30
---

# Handoff — the state a fresh session cannot recover on its own

Written when a session ends **mid-item**, and read as the first thing in the
next one. It is not a log: it is **overwritten every time**, and reset to
`status: empty` the moment the item flips to `done`. A handoff file that
outlives its item is worse than no handoff — the next session will trust it.

**Do not repeat anything that lives elsewhere.** The backlog says what the item
is. `MASTER_INDEX.md` says which unit owns it. `spec.py` says what it must do.
The code says what exists. This file holds only the four things that die with
the session:

1. what is half-written right now
2. the next concrete step
3. what was already tried and failed
4. what you and the agent decided out loud but never wrote down

If a session ended cleanly — item `done`, or never started — this file stays
`empty` and `/next` resumes with no help from it.

---

## Item

## Where it stands

## Files touched, and their state

| file | state |
|---|---|

## The next concrete step

## Dead ends — do not retry

| tried | why it failed |
|---|---|

## Decided in conversation, not yet written down

| decision | where it must land |
|---|---|
