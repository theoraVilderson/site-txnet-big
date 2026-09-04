---
id: handoff
status: empty            # empty | active
item: —                  # the backlog id currently mid-flight
updated: YYYY-MM-DD
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

`—` · unit `—` · spec: `python3 tools/spec.py <F-id>`

## Where it stands

<2–4 lines. What actually works *right now*, and how that was verified. Not
what is planned. "The service compiles and the happy path returns 200; nothing
touches the ledger yet" — that shape.>

## Files touched, and their state

| file | state |
|---|---|
| _apps/api/src/modules/billing/billing.service.ts_ | _debit() written and tested; refund() is a stub that throws_ |
| _apps/api/src/modules/billing/billing.repository.ts_ | _complete_ |

`state` must be honest and specific. "in progress" tells the next session
nothing. "half-written, the transaction wrapper is missing" tells it everything.

## The next concrete step

<One action, specific enough to begin without re-reading anything above tier 1.>

## Dead ends — do not retry

| tried | why it failed |
|---|---|
| _wrapping the two writes in a Prisma `$transaction`_ | _the ledger trigger fires per-statement, so the balance check saw a half-applied transaction_ |

**This is the most valuable section in the file.** A fresh session has no memory
of what did not work, so without it, it will confidently rediscover the same
wall you already hit — usually twice.

## Decided in conversation, not yet written down

| decision | where it must land |
|---|---|
| _refunds go to the wallet, never to the card_ | _an ADR, or a `D-nn` row in the catalog_ |

Anything here is a **leak**. It is real project knowledge that currently exists
only in a chat log. Empty this table by writing each row into its proper home —
that is part of finishing the item, not a follow-up.
