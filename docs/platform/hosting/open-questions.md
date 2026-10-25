---
id: hosting
layer: platform
updated: 2026-10-24
---

# Open questions — hosting

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-10-06 | A Postgres standby needs a second server (OPS-1-y). When does one exist, and where? | no — answered | DECIDED(2026-10-24, user): the dev host, joined as an agent and a worker since 2026-10-25 (contract.nodes.md K17) | closed |
| 2026-10-14 | Production on k3s needs a server of its own (OPS-1-p): the only host today is dev, which also runs the live site and bot. When does one exist? | no — answered | DECIDED(2026-10-24, user): the test server is production; the rehearsal runs on it (ADR-0163) | closed |
| 2026-10-24 | Does production on the test server start empty, or from a bundle (whose: the test server's own, or another server's)? | no — answered | DECIDED(2026-10-24, user): empty; the test server's data is test data, and the rehearsal's cluster is emptied before OPS-1-p opens it | closed |
| 2026-10-24 | The test server's disk syncs a write in ~148 ms (dev host ~2.6 ms; `dd oflag=dsync`, ROTA=1): Postgres commits at most ~7/s there, and the drill restored 45 MB in 316s. A faster disk (SSD/NVMe) before it is production? | yes, OPS-1-p | ASSUMED(2026-10-24): the rehearsal passes on it; production load would not. `synchronous_commit=off` is not an answer: it loses the last commits, payments among them | the user asks the provider for an SSD/NVMe disk or another server class |
| 2026-10-25 | The code's edge is Cloudflare (O1–O11, `edge_zone.py`), but mytxnet.ir's nameservers are ArvanCloud's (`*.ns.arvancdn.ir`): its CDN served the site from an origin other than the cluster, `api.` named the dev host DNS-only, and O7 admits Cloudflare's ranges only. Which edge? | yes, OPS-1-p | DECIDED(2026-10-25, user): Cloudflare. The zone moves to it (the registrar's nameservers), then `edge_zone.py apply` and `repoint` to the test server, with a token sealed in `.env.prod` | the user moves the zone and hands over the token and zone id |
