---
id: operations
status: active
updated: 2026-09-04
---

# Operations

| File | Purpose |
|---|---|
| [environments.md](environments.md) | env files, the dev/prod stacks, config keys, who owns each secret |
| [migrations.md](migrations.md) | schema/data migration policy + the not-yet-applied "section 99" SQL |
| [observability.md](observability.md) | the monitoring + bug-tracker + registry stacks |
| runbook-<incident>.md | one per known failure mode (none written yet) |
| slo.md | what "working" means numerically (not written yet) |

## Runbook template
```
Symptom -> how it pages -> first 3 checks -> mitigation -> root-cause notes -> owner
```

## Migration policy
- No migration is both destructive and irreversible in one deploy.
- Expand -> backfill -> contract, as three separate deploys.
- Every destructive migration lists its rollback plan before it is written.
