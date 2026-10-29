---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-29
---

# Contract — hosting: staging's copy of production holds nothing real

R14 restores production's data into staging, a network with no route out. That
network is one layer; this file is the second (ADR-0168 points 1, 2): one
mistake in either reaches no real panel and no real person.
`tools/k8s_staging_scrub.py`.

**R16 — The copy is scrubbed before any service of staging starts.**

- **When.** B10's restore into staging runs this checkout's `backup.py` into
  the worktree (`--checkout`), because production's commit may predate the hook,
  and its `--scrub` runs between the stores and the services: every workload is
  still at zero, only the stores are up. If the scrub fails, the restore stops
  there and no service starts. `restore` and `twin` alike.
- **Panels** (OPS-1-ah-f). A panel in service whose `apiBaseUrl` is plain http
  on production's server (`STAGING_PROD_SSH`'s host) at a port a local panel
  publishes (`/root/paneltest`) is pointed at that copy on staging's network:
  `apiBaseUrl`, `clientBaseUrl` (or null), `ipAddress`, with `knownAddresses`
  emptied. Its login stays, because the copies are the same panels with the
  same logins. Every other panel, archived or not, is wiped: its addresses
  become `http://192.0.2.1/wiped/<id>` and `192.0.2.1` (TEST-NET-1, so
  `panel_api_address_key` and the NOT NULL checks hold), its `knownAddresses`,
  `ovpnProfile`, `panelApiCredentials` and `panelRadiusSecret` are cleared, and
  it is archived (`retiredAt`), so every network-service loop skips it. In the
  vault, every `panel_credentials` row except the pointed panels' and every
  `source_panel_credentials` row are deleted. With no local panel running,
  every panel is wiped.
- **The guard.** It reads every panel row and the vault. It refuses, naming
  each one: an address field (`apiBaseUrl`, `clientBaseUrl`, `ipAddress`,
  `knownAddresses`) naming a host that is neither a local panel nor 192.0.2.1;
  any `ovpnProfile`; a wiped panel still holding a login or still in service;
  a vault login of no local panel (a deleted panel's counts); and any source
  panel's login. The twin runs it again after the new release's migration,
  before its checks (R14), and only panels in service there are counted as
  collected from.
- **A new contact column** (a panel address, a channel, a gateway) is added to
  the scrub and the guard in the same change, or the guard misses it
  (ADR-0168, consequences).

## Proof

`tools/k8s_staging_scrub_test.py` (14), `k8s_staging_data_test.py`,
`k8s_staging_twin_test.py`, `scripts/bundle/test_bundle.py`
(`test_a_scrub_that_refuses_the_copy_stops_the_restore_before_the_services`).
2026-10-29, the SQL run on dev's database inside a transaction that was rolled
back: 4 panels, 1 pointed and 3 wiped; 5 findings before (including a deleted
panel's login left in the vault), none after; every constraint held. That run
found `panel_api_address_key`, which is why each wiped address ends in its id.
