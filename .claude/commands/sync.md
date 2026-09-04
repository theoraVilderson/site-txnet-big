---
description: Bring the docs back in line with code that was written without an agent
---
Run `python3 tools/drift.py` first and report its output verbatim. Then follow
MODE: SYNC (`docs/00-PROTOCOL.md` §6f), in the report's own order:

1. **Ambiguous ownership** — fix before anything else. A `source:` glob that
   does not contain its unit id hides every orphan inside it, so the rest of the
   report is not trustworthy until it is narrowed. Re-run `drift.py` after.
2. **Orphans** — code no unit claims. For each, state whether you think it is a
   new unit or belongs in an existing one, **and ask**. Do not create a unit
   without confirmation: unit boundaries are the most expensive thing in the
   repo to get wrong.
3. **Broken references** — a doc points at a file that moved or was deleted.
   Update `source:` and the `SURFACES.md` component path. Mechanical; just do it.
4. **Likely new surfaces** — propose a `SURFACES.md` row for each, with aliases
   in the words the user would say. Show the rows before writing them.
5. **Spec ids in commits** — check the code against `python3 tools/spec.py
   <F-id>` before flipping any backlog row. A commit message is a claim, not
   proof. If it is partly built, the row is `doing` with a note, not `done`.
6. Update each touched unit's `INDEX.md`: `source:`, `status`, `updated`, and
   the changelog line.

Rules:

- **Read the code before you write about it.** You did not write this week's
  code and you do not know its intent. Where behaviour is not obvious, say what
  you inferred and ask rather than documenting a guess as fact.
- Do not invent invariants, contracts or rules from reading an implementation.
  What the code does is not necessarily what it must do. Ask which is which.
- Do not touch `App-Features.md`. New capabilities built this week that are not
  in the catalog are a question for the user, then MODE: EXTEND.
- Anything unresolved goes in the unit's `open-questions.md`, not into a doc as
  a confident statement.

Finish by running the four checkers, then say explicitly that
`python3 tools/drift.py --update-marker` is the user's call, and do not run it
yourself.
