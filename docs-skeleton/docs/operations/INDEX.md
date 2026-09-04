---
id: operations
layer: operations
status: active
---

# Operations

| doc | when you need it |
|---|---|
| environments.md | what runs where, which env vars, which secrets |
| migrations.md | schema change procedure + who owns hand-written SQL |
| observability.md | metrics, alerts, and the runbook each alert links to |

Every alert must link to a runbook. An alert with no runbook is ignored at 3am.
