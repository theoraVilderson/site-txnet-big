---
id: dependency-graph
status: draft
---

# Dependency graph

GENERATED where possible (`python3 tools/docs-check.py` prints the consumer map)
plus manual runtime edges it cannot see (queues, webhooks, cron).

Read this before any change: your blast radius is the unit plus every unit
listing it in `depends_on`.

```
```
