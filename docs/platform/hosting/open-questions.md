---
id: hosting
layer: platform
updated: 2026-10-24
---

# Open questions — hosting

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-10-06 | A Postgres standby needs a second server (OPS-1-y). When does one exist, and where? | yes, OPS-1-y only | ASSUMED(2026-10-06): one server until the user provides a second; the design is fixed in contract H22, only the host is missing | the user names the server -> OPS-1-y `todo` |
| 2026-10-14 | Production on k3s needs a server of its own (OPS-1-p): the only host today is dev, which also runs the live site and bot. When does one exist? | no — answered | DECIDED(2026-10-24, user): the test server is production; the rehearsal runs on it (ADR-0163) | closed |
| 2026-10-24 | Does production on the test server start empty, or from a bundle (whose: the test server's own, or another server's)? | yes, OPS-1-p only | ASSUMED(2026-10-24): undecided; OPS-1-o-f rehearses with the test server's own data, which is test data | the user answers -> OPS-1-p's restore step |
