---
id: hosting
layer: platform
updated: 2026-10-06
---

# Open questions — hosting

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-10-06 | A Postgres standby needs a second server (OPS-1-y). When does one exist, and where? | yes, OPS-1-y only | ASSUMED(2026-10-06): one server until the user provides a second; the design is fixed in contract H22, only the host is missing | the user names the server -> OPS-1-y `todo` |
