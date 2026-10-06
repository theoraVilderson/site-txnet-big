---
id: features-dropped
status: active
---

# Deliberately not built

Catalog ids that will **not** get a backlog row. Every drop needs a reason and a
date. This file is what makes "nothing was silently lost" verifiable — without
it, a missing id is indistinguishable from an accident.

`python3 tools/features-scan.py --check` counts a row here as covered.

| catalog id | feature | reason dropped | date |
|---|---|---|---|
| F-205 | Gradual migration — TXNet configs alongside legacy configs in the same link | Needs a standing connection to the reseller's old panel; D-63 reads it once and destroys the login. F-211's rollback window gives the same safety | 2026-10-06 |
