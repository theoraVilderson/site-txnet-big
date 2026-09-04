---
description: Report drift between docs, backlog, catalog and code
---
Read `docs/00-PROTOCOL.md` and run MODE: AUDIT. Run all four checkers and report
their output verbatim alongside your table. Change nothing.

```bash
python3 tools/docs-check.py
python3 tools/backlog.py
python3 tools/features-scan.py --check
python3 tools/where.py --check
python3 tools/conventions.py --list
```
