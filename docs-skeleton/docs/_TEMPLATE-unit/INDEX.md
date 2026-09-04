---
id: <kebab-case-id>          # stable, unique, NEVER renamed
layer: domain                # domain | interface | platform
status: draft                # draft | active | deprecated | superseded
version: 1                   # contract version. bump = breaking change.
source: []                   # real code paths. empty means NOT IMPLEMENTED.
owns_tables: []
depends_on: []
updated: YYYY-MM-DD
---

# <Unit name>

One paragraph: what this unit is responsible for, and the one thing it must
never be confused with.

**This file is a router, max 40 lines. Never put content here.**

| file | read it when |
|---|---|
| [contract.md](contract.md) | using or changing this unit from the outside |
| [invariants.md](invariants.md) | changing anything inside it |
| [rules.md](rules.md) | writing code inside it |
| [data-model.md](data-model.md) | touching its tables |
| [open-questions.md](open-questions.md) | something here is undecided |

Create the optional files **only if non-empty**. Never create an empty file.

## Changelog
| date | change |
|---|---|
| YYYY-MM-DD | created |
