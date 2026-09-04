---
id: <same-id>
status: draft
updated: YYYY-MM-DD
---

# <Unit> - open questions

Every row needs a date, a blocking flag, and an exit path. An entry with no date
is invalid. Entries older than 30 days must be raised proactively
(`tools/docs-check.py` warns).

BLOCKING = affects the data model, money, auth, tenancy, or anything
irreversible. Do not proceed past a blocking question; ask.

| date | question | blocking | exit path |
|---|---|---|---|
| YYYY-MM-DD | | yes/no | becomes a rule / becomes an ADR |
