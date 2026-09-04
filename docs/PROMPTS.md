# Ready-to-use prompts

**Bootstrap a project**
> Read `docs/00-PROTOCOL.md`. Run MODE: BOOTSTRAP for this project: <description,
> however incomplete>. Start with the glossary and the invariants. Do not invent
> fields or endpoints — put gaps in open-questions.md and ask me.

**Add a feature**
> Follow MODE: EXTEND in `docs/00-PROTOCOL.md` for: <feature>. Before editing,
> tell me the classification (existing unit / new unit / cross-unit) and the
> blast radius.

**Write the code**
> Follow MODE: IMPLEMENT for unit `<id>`. State the file plan and the invariants
> in play first, then implement.

**Health check**
> Run MODE: AUDIT. Report drift as a table. Change nothing.

**Onboard an existing codebase**
> Run MODE: BOOTSTRAP, but derive units from the existing code instead of a
> description. Fill `source:` from real paths. Anything you cannot verify in code
> goes to open-questions.md, not into contract.md.

---

**Half-built project — run once, first**
> Read `docs/00-PROTOCOL.md`. Run MODE: RECONCILE. Report the table. Change
> nothing until I approve.

**The delivery loop — this is the "just keep going" prompt**
> Run MODE: NEXT.

Repeat it. Each run picks the next unblocked item, implements it, updates the
backlog, and stops. A fresh session needs no other context.

**Check progress**
> ```
> python3 tools/backlog.py
> ```
