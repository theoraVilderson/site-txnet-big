---
id: hosting
layer: platform
updated: 2026-10-24
---

# Open questions — hosting

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-10-06 | A Postgres standby needs a second server (OPS-1-y). When does one exist, and where? | no — answered | DECIDED(2026-10-24, user): the dev host, joined as an agent tainted `txnet.io/no-release` (contract.nodes.md K17) | closed |
| 2026-10-14 | Production on k3s needs a server of its own (OPS-1-p): the only host today is dev, which also runs the live site and bot. When does one exist? | no — answered | DECIDED(2026-10-24, user): the test server is production; the rehearsal runs on it (ADR-0163) | closed |
| 2026-10-24 | Does production on the test server start empty, or from a bundle (whose: the test server's own, or another server's)? | no — answered | DECIDED(2026-10-24, user): empty; the test server's data is test data, and the rehearsal's cluster is emptied before OPS-1-p opens it | closed |
