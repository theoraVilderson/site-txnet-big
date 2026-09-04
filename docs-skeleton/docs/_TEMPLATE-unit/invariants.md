---
id: <same-id>
status: draft
updated: YYYY-MM-DD
---

# <Unit> - invariants

Things that must never happen. These outrank every contract and every
convenience (§0 of `00-PROTOCOL.md`). If a requested feature needs one of these
broken, stop and say which one.

Source them from the catalog INV-nn rows - copy the id so the two stay linked.

| id | invariant | enforced by | blast radius if broken |
|---|---|---|---|
| INV-01 | | DB constraint / trigger / test | |

An invariant enforced only by "we will remember" is not enforced.
