---
id: master-index
status: active
updated: YYYY-MM-DD
---

# Master Index

Entry point for every task. One line per unit. **Never add detail here.**

Legend — `status`: `active` = implemented in code; `draft` = schema/intent only,
no service yet. A unit that is `active` with an empty `source:` is a lie and
`tools/docs-check.py` will fail on it.

## Domains — business logic, owns state
| id | one-line responsibility | status | doc |
|---|---|---|---|
| _example_ | _users, RBAC, sessions_ | _active_ | _[->](domains/example/INDEX.md)_ |

## Interfaces — outside-world touchpoints
| id | surface | status | doc |
|---|---|---|---|
| | | | |

## Platform — cross-cutting, no business rules
| id | capability | status | doc |
|---|---|---|---|
| | | | |

## Cross-cutting docs
- [Backlog](BACKLOG.md) — what is built vs not; read with this file for MODE: NEXT
- [Feature catalog manifest](features/MANIFEST.md) — the spec index. Never open the catalog itself.
- [Feature format](FEATURES-FORMAT.md) — the contract the catalog must satisfy
- [Architecture overview](architecture/overview.md)
- [Dependency graph](architecture/dependency-graph.md) — read before any change
- [Decisions (ADR)](architecture/decisions/)
- [Glossary](GLOSSARY.md) — check before naming anything
- [Operations](operations/INDEX.md)
- [Security](security/threat-model.md)
