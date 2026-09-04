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
