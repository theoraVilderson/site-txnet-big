---
id: hosting
layer: platform
updated: 2026-10-14
---

# Open questions — hosting

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-10-06 | A Postgres standby needs a second server (OPS-1-y). When does one exist, and where? | yes, OPS-1-y only | ASSUMED(2026-10-06): one server until the user provides a second; the design is fixed in contract H22, only the host is missing | the user names the server -> OPS-1-y `todo` |
| 2026-10-14 | Production on k3s needs a server of its own (OPS-1-p): the only host today is dev, which also runs the live site and bot. When does one exist? | yes, OPS-1-p only | ASSUMED(2026-10-14): none yet (user); OPS-1-o-* are proven on the k3d rehearsal cluster instead (K12) | the user names the server -> OPS-1-p `todo` |
