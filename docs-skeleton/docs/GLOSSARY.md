---
id: glossary
status: active
updated: YYYY-MM-DD
---

# Glossary

One term = one meaning across the entire project. Check here **before**
introducing any new noun. If a concept already has a name, reuse it; if you must
introduce a synonym, record why.

Fill this **first**, before any unit file exists. Names are the backbone: if
`user`, `customer` and `account` are not unified now, they become three tables
and three domains later, and no amount of refactoring fixes it cheaply.

Source the terms from `features/MANIFEST.md` — its entity column is the list of
nouns the catalog actually owns.

| Term | Meaning | Owning unit | Do NOT confuse with |
|---|---|---|---|
| _Example_ | _one sentence, concrete, names the field or table where it lives_ | _identity_ | _the term it gets mixed up with_ |

## Banned words
Terms that were ambiguous and are now forbidden project-wide. Every row here is
a bug that was caught once and must never come back.

| Banned | Use instead | Why |
|---|---|---|
| _customer / account (for a person)_ | _User_ | _three names for one identity would become three tables_ |
