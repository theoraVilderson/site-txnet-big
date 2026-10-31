---
id: operations
status: active
updated: 2026-10-23
---

# Operations

| File | Purpose |
|---|---|
| [environments.md](environments.md) | env files, the dev/prod stacks, config keys, who owns each secret |
| [migrations.md](migrations.md) | schema/data migration policy + the not-yet-applied "section 99" SQL |
| [observability.md](observability.md) | the monitoring + bug-tracker + registry stacks |
| [runbook-restore-database.md](runbook-restore-database.md) | restore Postgres whole, to a point in time, or onto a new server (OPS-1-e) |
| [runbook-move-cluster.md](runbook-move-cluster.md) | move production's k3s cluster to another server, one writer at any moment; the rehearsal and the real move (OPS-1-am) |
| [runbook-move-server.md](runbook-move-server.md) | move the whole platform to another server or datacenter, every byte of state (OPS-1-ac) |
| [runbook-backup-bundle.md](runbook-backup-bundle.md) | the whole platform as one encrypted file: make now/nightly, ship to S3, bring it up here or on a new server (OPS-1-ad) |
| runbook-<incident>.md | one per known failure mode |
| slo.md | what "working" means numerically (not written yet) |

## Runbook template
```
Symptom -> how it pages -> first 3 checks -> mitigation -> root-cause notes -> owner
```

## Migration policy
- No migration is both destructive and irreversible in one deploy.
- Expand -> backfill -> contract, as three separate deploys.
- Every destructive migration lists its rollback plan before it is written.
