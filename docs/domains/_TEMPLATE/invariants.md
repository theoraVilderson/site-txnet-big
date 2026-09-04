---
id: TEMPLATE
layer: domain
status: draft
updated: 2026-09-03
---

# Invariants — <unit>

Statements that must be true at all times. **Outrank every feature request.**
If a request requires breaking one, stop and escalate.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | _e.g. balance is never written directly; only derived from ledger entries_ | DB constraint / service layer | silent money loss |

## How to test
One line per invariant: the test or constraint that proves it.
