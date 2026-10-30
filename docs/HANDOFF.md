---
id: handoff
status: active           # empty | active
item: LIVE-1              # the backlog id currently mid-flight
updated: 2026-10-29
---

# Handoff — the state a fresh session cannot recover on its own

Written when a session ends **mid-item**, and read as the first thing in the
next one. It is not a log: it is **overwritten every time**, and reset to
`status: empty` the moment the item flips to `done`. A handoff file that
outlives its item is worse than no handoff — the next session will trust it.

---

## Item

LIVE-1 — the driver end-to-end test on the test server (2.144.31.149), run as
the reseller `chillshop` (tenant `mmd-brnd`, `764accc1-aeb0-43e1-aa0f-8a08e0af8510`,
`panel.chillshop.ir`, subscriptions on `sub.chillshop.ir`). Deployed release
there: `2adee9c8` (BYO-1-a, BYO-1-b, F-027-bb-a, F-027-ba-a all live).

## Where it stands

Proven live, through the API exactly as users do:
- 6 real panels registered by the reseller through its own door (BYO-1-b),
  all `accepted`/healthy: marzban, marzneshin, sanaee (3x-ui 2.9.4),
  three_x_ui (3x-ui 3.11.0), x_ui_alireza, mikrotik_user_manager.
- 15 groups (one per panel×inbound) and 30 variants (`PKG-*` 300 MB/30 d $1,
  `PAYG-*` metered 0.50/GiB) on the reseller.
- Buyers `e2e_buyer01`, `e2e_buyer02` signed up on panel.chillshop.ir (OTP read
  from the auth-service log), funded through a card-to-card manual gateway the
  reseller confirms.
- Concurrent purchases: 5 then 10 at once — wallet exact, no double spend.
- Marzban: usage exact (100.0 MB), automatic cut-off (grant `suspended`, new
  connections refused), renewal reconnects in ~40 s.
- Marzneshin grant delivered after the F-027-ba-a fix.

**Usage stall on sanaee/alireza — resolved 2026-10-26, not a bug.** Metering
billed the rest at 16:39:45 / 16:40:04 UTC, ~3 min after network-service was
rolled for `2adee9c8` (~16:36); the earlier reads fell in that gap. All 10 now
equal the panel counters (100.0 MB). No quarantine, no cap hit.

**Cut-off + renewal on every Xray family — done 2026-10-26** (buyer02 250 MB
more at 2 MB/s on 9 configs; buyer01 Marzneshin 4×100 MB at 1 MB/s):

| family | cut | platform at the end | new connection | renewal back |
|---|---|---|---|---|
| marzban | after the fact | 349–350 / 300 | refused | ~40 s (earlier session) |
| sanaee (3x-ui 2.9.4) | in flight, guard band at 255 MiB, reopened on settle (lease-close rule 25), cut again at ~293 | 293–294 / 300, `active` | refused | 30 s |
| three_x_ui (3.11) | in flight at ~293–295 | 292–295 / 300, `active` | refused | 41 s |
| x_ui_alireza | **not in flight**: whole 250 MB served | 350 / 300, suspended | refused | 41 s |
| marzneshin | **not in flight**: whole 400 MB served; usage exact (400.0) one pass later | 400 / 300, suspended | refused | 41 s |

The x-ui closes with 5–8 MB left stay `active` but disabled: package plan,
under `ReopenMin` — lease-close rule 26 / ADR-0105 (0), as designed. Renewal
bag = used + 300 (alireza 650, marzneshin 700): overshoot forgiven (finding 10).
Driver: `e2e.py renew <account> <grant-prefix…>` (invoice with `grantId`, pay);
client `pt-client4` (33000–33003) = buyer01's Marzneshin links, config in
`/root/paneltest/client4`.

**Bulk test — in progress 2026-10-26** (user: admin route, 2 more resellers):
- Test server `/root/ptbulk` (compose `ptbulk`): Marzban `mz-a1` :28010 (200
  legacy clients `bka*`, chillshop's import source — not registered),
  `mz-b1` :28020 (400 `bkb*`), `mz-b2` :28030, `mz-c1` :28040 (400 `bkc*`),
  `mz-c2` :28050; Xray ports 24101+…24501+. `fill.py <port> <prefix> <n>`.
- chillshop: migration run `1166fdf7…` from mz-a1 committed 201/201 in 2.5 min
  (VLESS → PKG-MARZBAN-VLESS, the 1 Shadowsocks client → PKG-MARZBAN-SHADOWSOCKS);
  provisioned on chill-marzban ~18:45:30–18:53 UTC (~27 configs/min).
  chill-marzban now holds 205 Grants; move job **not started** — all three
  resellers start together.
- Resellers (user created them 2026-10-27): `e2eresb` `3024a438-83ab-4c54-9cdf-648f1204390b`
  (owner `e2e_resb`), `e2eresc` `57d73e3a-4620-4d3b-bdc1-1ffc679bb277` (owner `e2e_resc`),
  both `trial`. The platform key was not needed in the end.
- Registrations timed out on the serial canary loop → F-027-fi built,
  committed `56dd8a6e`, deployed `56dd8a6e158e` (network-service only rebuilt,
  `HOST_GATEWAY=2.144.31.149 scripts/prod.k8s.sh deploy` on the node); all four
  then accepted in 30 s, no canary written.
- B: panels `resb-b2` 946e3a9a (landing, group `resb-mz` ced1c46a, variant
  `PKG-RESB-1G` 31fc433b) and `resb-b3` fd4c1529 (move target). Run `5b586c88…`
  from mz-b1: 400 committed + 1 failed (bkb0080) by 05:34 UTC.
- C: panels `resc-c3` 8dd8936b (landing, group `resc-mz` 58c91e71, variant
  cc2d01e0) and `resc-c2` aa2859ac (move target). Run `d7a3425e…` from mz-c1:
  400/400 committed 05:09:40–05:27.
- **F-027-fj** (user 2026-10-27, "separate building from collection"):
  `60eb70ad` (≤10 creates a turn, the waker carries the rest) + `037ae042`
  (and none after a 10 s window), both deployed with the user's approval;
  running `037ae042` (image `network-service:d41b32c9b4cf`) since 06:52 UTC.
  The bulk pass completes again (every ~2.7 min, not 1): what is left is the
  node's disk — `/proc/pressure/io` full ≈52 % over 5 min, Postgres on
  WALWrite/WalSync; the test containers write little, the k3s workloads
  (Postgres, Loki) on a slow VPS disk do. Finding 14.
- Provisioning at 06:57 UTC: mz-b2 1183/1600, mz-c3 1096/1600, ~12/min each
  (~420 / ~510 deferred), now on woken turns.
- **2026-10-28 later**: all 300 moved users complete on their targets
  (400/400/100); the panel-down drill (resc-c2 stopped 11:50:41–11:54:10,
  mid-move) recovered with nothing lost (334 → 403 users), passes went on.
  **F-027-fk** (`3c98903e`, deletes budgeted + stall) deployed 12:17 UTC:
  first pass 10/10 collected. **F-027-fl** (`e213d1e9`, Marzban delete
  disables first, a landed 500 is a delete) deployed 12:3x UTC; the three
  Marzbans restarted 12:40 (restart the `*-web` nginx sidecar too: it shares
  the network namespace, or the panel stops answering — cost 4 min).
  **Bulk move done 12:50 UTC**: 300 users complete on the targets, every old
  config deleted and confirmed, source Marzbans −400 users each, deletes 0
  failed, passes 10/10.
  Marzban 0.8.4 answered 500 to every delete: the users left Marzban's
  database but Xray kept serving them (FastAPI drops background tasks on an
  error) — after the deploy, restart mz-b2, mz-c3 and paneltest-marzban to
  flush those already leaked from Xray.
- **Bulk move (user: 100 users per reseller, 2026-10-28)**: config move
  jobs are repairs inside a group (finding 20) — the user move is the grant
  group move. Target groups: B `resb-mz2` 71dc7a29 on resb-b3, C `resc-mz2`
  e518bcc5 on resc-c2 (each with a PKG variant: a group move only targets a
  group the reseller sells), chillshop `chill-marzneshin-all` 6c2ea3d4.
  Jobs C `12a4adca…`, B `8673360b…`, chillshop `4a8fc4e0…` started together
  11:35:58 UTC; done by 11:42:34. DB at 11:45: every moved user has its
  configs re-made on the target (400 / 400 / 100) and the old ones `absent`,
  none doubled; creates/deletes converging (watch with
  `/tmp/claude-0/s/move-check.sql`). Usage carry-over not tested (the users
  had none).
- Then per reseller: own door `add-panel` (b1+b2 / c1+c2), group + PKG variant,
  migration from b1/c1 (`e2e.py migrate`, map every inbound with clients —
  a null one sends the run back to draft), then config move jobs on all
  three at once (`/configs/move-jobs`, source `{panelId}`), check outcomes,
  old configs retired, usage carried, no double count.

## Files touched, and their state

| file | state |
|---|---|
| repo | clean except `docs/BACKLOG.md` (LIVE-1 row) and this file. All code is committed and deployed |
| `/tmp/claude-0/s/e2e.py` (scratch, not in repo) | the API driver: `login`, `call`, `setup-panels/groups/catalog`, `register`/`verify`, `offers`, `buy-many`, `grants`, `sublinks`. The user allowed `Bash(python3 /tmp/claude-0/s/e2e.py:*)`. State in `e2e-state.json`, sessions in `sessions/`, passwords in `accounts/` |
| `/tmp/claude-0/s/livecheck-v3` + `zz-livecheck-src/` (scratch) | driver-level live tool; must never be put back under `network-service/cmd/` before a build (the release build refuses a dirty checkout) |
| test server `/root/paneltest` | compose project `paneltest` (panels, file server :28999), clients `pt-client`(30000+), `pt-client2`(31000+), `pt-client3`(32000+), `pt-client4`(33000+); `traffic.sh <bytes> [ports]`, `RATE=5M` throttles |

## The next concrete step

**2026-10-29 session — start here.** Done and deployed (release `ec7afa6d`,
test server): LIVE-1-d, -e, -f (dropped), -g, -h, -j, -k; -h and -j verified
live (see the list below). LIVE-1-ad done and deployed (`4b8a0cfa`); measures
below were the "before". **Next: LIVE-1-l** (first open bug in the list). What was measured (read-only, test
server 06:35–06:50 UTC):

- Disk `vda`: ~11 ms per write, so ~90 writes/s; idle load 33.5 writes/s
  (669 KB/s), `/proc/pressure/io` full ~23–33 %. The volume is tiny; the
  count of writes is the cost. That is LIVE-1-i's whole story.
- Per writer (cgroup `io.stat`, 60 s): main-db 13.8 writes/s, k3s 10.5,
  journald 6.4 (only ~1 log line/s, mostly ssh), Loki 0.3.
- Postgres, rows written in one idle minute (`pg_stat_user_tables` delta):
  `network.config_counter_state` 15,513, `network.config` 4,197, all else ~550.
  25 commits/s.
- Causes: `network-service/internal/collect/postgres.go` `applySQL` upserts
  every advance each pass, changed or not (only `lastObservedAt`/
  `lastPublishedAt` move — no reader anywhere); `internal/converge/postgres.go`
  `recordSQL` writes `lastReconciledAt` (read only by billing
  `traffic/user-configs.ts`, shown on the reseller users page) and
  `linksCheckedAt` (read by converge line ~78) every pass.
- Plan (approved): skip an advance whose counters equal the stored cursor;
  write `lastReconciledAt` only when it is ≥10 min old or something else in
  the row changes; check `linksCheckedAt`'s reader before touching it. Test
  first (Go). Deploy, re-measure the same three numbers, then close LIVE-1-i
  with them.
- "systemd 175 GB" was an accounting artefact: PID 1 inherits the I/O of every
  process it reaps. Not a writer itself.
- Test runs left behind: migration run `78d95817` (cancelled, chillshop),
  category `e2e_live1j` (deleted).


**Concurrent test, 2026-10-28 — run once, 17:03:44 UTC.** Fixed and deployed
on the way (release `4f0e2d581771`): LIVE-1-u `f70f9e6c`, F-118-n7 `3e377d9f`,
LIVE-1-v `15077306` (superseded by LIVE-1-w `4f0e2d58`, FOR NO KEY UPDATE),
LIVE-1-a `1bce5257` (user: billing pool 20, maxWait 10 s). WG-1 filed (todo).

Rig (test server): marznode now also runs sing-box (`/root/paneltest/marznode/
singbox_config.json`: HY2 25011/udp, TUIC 25012/udp, VLESS 25013) → Marzneshin
service `sb` (id 2); CHR is its own NAS (OpenVPN tcp 21194, L2TP udp **1701**
on the host, no IPsec — slirp cannot pass ESP), `chr/chr.sh` mounted;
`pt-vpnclient:1` image (openvpn, xl2tpd, sing-box 1.11.3); `/root/paneltest/
live1c/` = `run.sh` (sing-box, 407 streams), `tun.sh`, `launch.py`, results.
`compose.yml.bak-20261028` is the file before. chillshop: group `chill-all`
a2d78cd7 (all 6 panels, every inbound; three_x_ui lists 1 and 3 — 2 is
every-group), variants `all:PKG`/`all:PAYG`; buyers e2e_buyer01–12 (03–12 new,
phones 0912000010N), $5 each via `e2e.py fund`. `e2e.py` gained setup-mixed,
signup-many, fund, buy-fleet, logins, login-all, group-move-back.

Results: purchases — 30 at once: 4 ok before the fixes, all ok after (13 on
one variant); delivery bursts recover by retry (LIVE-1-x). Moves — chillshop
102, B 100, C 100 Grant group moves started in one second under traffic: done,
0 failed (counts 99/94/98: LIVE-1-p). Traffic — every family and HY2/TUIC
served full downloads except three_x_ui (Xray restarts, LIVE-1-y). Usage —
platform equals the panel where checked (Marzban 741 = 741 MiB), but panels
under-record: Marzban SQLite lost ~500 MiB (LIVE-1-aa), 3x-ui loses on each
restart; PKG bags of 300 MB served 340–420 MB to clients (open connections,
F-027-cm). Tunnels — OpenVPN and L2TP authenticate through User Manager and
are metered (b09 20.3 MiB client / 26.5 platform), but the emulated CHR does
~40 KB/s, gave one `radius timeout` and two L2TP PPP failures: rig limits.
Unattributed usage reads TiB for the old `lc*` clients (LIVE-1-z).

LIVE-1-y **done 2026-10-28, `b59a829b`, deployed 17:58 UTC** (release
`b59a829b6190`, image `network-service:7bc58eee74dc`): not our write volume —
zero-lease replicas (ceiling = used) were cut by 3x-ui's traffic job
(restartXrayOnClientDisable → forced restart) and re-enabled by converge each
pass. Verified: xui2 restarted every ~10 s until 17:58:35, then 0 in the next
3.5 min; xui3 and xuia 0. Next: LIVE-1-aa's decision, LIVE-1-z, LIVE-1-x;
WG-1 after. Not done yet: PAYG
blocks were not driven to an empty wallet. A Grant moved right after its
traffic (b11 c05dd571, Marzneshin → marzban-vless) kept its 400 MiB = client.

### The user's test list (2026-10-26) — what is left

| step | state |
|---|---|
| Buy 10 configs at once, each a different protocol, real traffic | **done** (buyer02: 10 paid in 2 s, wallet exact; 9 Xray configs carried 100 MB each). User Manager carried none: no OpenVPN client yet |
| Money and usage figures | wallet **done**; usage exact on marzban, marzneshin, three_x_ui; exact on sanaee/alireza too (the stall was a rollout gap); PAYG not testable until the wholesale decision |
| Automatic cut-off | **done on every Xray family** (table above); left: User Manager (needs OpenVPN); PAYG cut-off (wallet empty) after the decision |
| Renewal | **done on every Xray family** (30–41 s); left: User Manager |
| Bulk moves of ~1000 users across panels, several resellers at once, each on its own panels | **done 2026-10-28 at 300 users** (user chose the smaller size; 1000 imported) — see above. Was: needs a second reseller (and a third) with their own panels/groups, ~1000 Grants (reseller bulk issue or many buyers), then the reseller move job (`reseller-config-move-job`, F-311-ad) / group move on all at once; check every user lands, old configs retire, usage carries over, no double count |
| Failure drills: stop/restart panels, network-service, billing, worker, main-db, a whole node; panel down mid-move; a cut while billing is down | **2026-10-28 done:** panel down mid-move (passed), network-service ×5 via deploys (passed), billing rolling restart under 6 buys (all paid once, delivered, $17→$11), main-db restart (DB out ~30 s, collection gap ~2.5 min, 7 Nest services restarted — LIVE-1-r/s/t; buy after recovery OK). **Repeated 13:30:59 UTC after LIVE-1-r (`eefb177d` + `d3cf39d3`) and LIVE-1-s (`91745242`) were deployed:** DB out ~20 s, **0 service restarts**, full collection pass 13:32:21, buy OK ($10→$9). **Cut while billing is down (2026-10-28 13:50–13:53 UTC, billing at 0 replicas): passed** — network-service cut the sanaee client in flight at 572.4/600 MiB and refused new connections with no billing pod; after billing returned, platform = panel counter exactly (600,221,813 B); the panel counts ~4.6 MiB less than the client received (its last stats interval before the disable). Found LIVE-1-u (the guard close never reopened). **Left:** worker, a whole node. Was: record what users see and whether counts/charges stay exact after recovery |

### To do — the whole list (user, 2026-10-28: "add all of them to the handoff")

Work top to bottom; tick a line here when it lands. Each code item already has
its backlog row (`python3 tools/brief.py <id>`).

**0. Housekeeping first**
- [x] Commit the uncommitted backlog rows — `100c5ef9`.

**1. Bugs, no decision needed** (todo rows)
- [x] LIVE-1-z — done `e6714830`, deployed 19:52 UTC (release `e6714830fd67`).
  The old pods re-inflated 14 rows during the rollout; set to their cursor by
  hand 19:56. Verified: rows = panel total, unchanged across passes. Then the `lc*` clients (item 5).
- [x] LIVE-1-x — done `a0c14c22`, deployed 20:2x UTC: 13 at once on chill-all,
  all placed on attempt 1 (1.0–3.4 s), active by 20:34:47, no 500.
- [x] LIVE-1-ab — done `6bceea73`: `in_registry` asks `buildx imagetools`, retries a
  dropped request; real registry at HEAD: 0 of 22 would push. Build host only.
- [x] LIVE-1-b — done `2c961fac`, deployed 21:21 UTC (release `2e4ffdf0b8bb`, billing `674e6c06d692`): the receipt read was nested inside the proof write; 2 live proofs 200.
- [x] LIVE-1-d — done (commit below), **not deployed**: a product sheet read each
  variant's cost (32 reads); now one `GET …/products/:id/variant-costs`.
- [x] LIVE-1-e — done (user chose two budgets), **not deployed**: desired-state
  writes on `SYSTEMS_ADMIN_SETTINGS` 300/15 min, remote/job writes keep 30.
  Deploy LIVE-1-d + LIVE-1-e together (user 2026-10-29). Release `0606f722`:
  **deployed 2026-10-29** (release `0606f7220cc8`). Live: `GET …/products/:id/
  variant-costs` answers chillshop's product. A 35-write burst to prove the
  300 budget was refused by the classifier (shared resource) — not run.
- [x] LIVE-1-f — dropped, not a bug: the 409 is ADR-0127 (6) as designed.
- [x] LIVE-1-g — done: the test now names the 8 platform keys (stale since ADR-0164).
- [x] LIVE-1-h — done (user: explicit skip), deployed `ec7afa6d` (migration applied), **verified live**
  2026-10-29: run 78d95817 from mz-a1, both inbounds skipped → previewed, 201 × inbound_skipped, skip+variant 400; run cancelled: migration
  `20261029000100_a_migration_inbound_can_be_skipped` (additive) + panel "do not import".
- [x] LIVE-1-i — closed (commit after `4b8a0cfa`): io full 23–33 % → 4–5 %; writes/s
  unchanged (~34 vda, 14 main-db) — they follow ~22 commits/s, not rows.
- [x] LIVE-1-ad — done `1c02bcc2` + `4b8a0cfa`, deployed (release `4b8a0cfaaea5`,
  07:4x UTC): standing cursors, unchanged records and repeated ceiling confirmations
  write every 10 min. The 4.2k config rows/min were `ceilingAppliedAt`, not
  `lastReconciledAt`. Idle rows written ~20k/min → ~600/min; io full ~2 %.
- [x] LIVE-1-j — done (user: publish before), deployed `ec7afa6d`, **verified live**
  2026-10-29 (category e2e_live1j: 201, same key 409 key_taken, name not overwritten, deleted): catalog names
  published before the transaction, cleared after it.
- [x] LIVE-1-k — done, deployed `ec7afa6d`: a passing DB fault leaves the item pending.
- [ ] LIVE-1-l — a migration drain whose lease release fails leaves the run unclaimed.
- [ ] LIVE-1-m — link capture after a restart is unbounded.
- [ ] LIVE-1-n — reseller users list pages overlap.
- [ ] LIVE-1-o — config move targets wider than a move can go.
- [ ] LIVE-1-p — move job counters undercount.
- [ ] LIVE-1-q — move jobs of different resellers run one after another.
- [ ] LIVE-1-ac — `ObjectStorage.put` writes the file inside the transaction (C-29), every upload.

**2. Decisions to ask the user** (in Persian, with a recommendation)
- [ ] LIVE-1-aa — Marzban on SQLite loses usage under load: pace our
  reads/writes on a SQLite Marzban, or require MySQL. Investigate first.
- [ ] LIVE-1-c — reseller coupon/gift door (`coupon.manage` is platform-only).

**3. Features**
- [ ] WG-1 — MikroTik WireGuard driver (user asked 2026-10-28).
- [ ] BYO-1-c — systems page in `/my-resellers/[id]/systems`, then close the
  BYO-1 umbrella with its children's proof.
- [ ] Hiddify — needs a separate server before it can be tested at all.

**4. Test steps still open** (on the test server, as real users)
- [ ] three_x_ui traffic re-run under concurrent load: the earlier result was
  spoilt by the LIVE-1-y restarts (fixed).
- [ ] PAYG blocks driven to an empty wallet: the PAYG cut-off.
- [ ] User Manager cut-off + renewal over OpenVPN/L2TP (CHR 1194 → host 21194;
  the emulated CHR is slow, ~40 KB/s).
- [ ] Usage carry-over on a move: move a Grant that has usage, check no double
  count (b11 c05dd571 kept 400 MiB = client; repeat on purpose).
- [ ] Failure drills left: stop the worker; take down a whole node.

**5. Clean-up when LIVE-1 ends** (ask the user before each removal)
- [ ] Tell the user to change `0mikeWilson1`'s temporary password (in
  `/tmp/claude-0/s/accounts/`, scratch only).
- [ ] Test data on the cluster: buyers `e2e_buyer01…12`, gateway `f580e11c…`
  (card 6037990000001236), category/product `vpn_e2e`, `chill-*` groups and
  panels, resellers `e2eresb`/`e2eresc` and their panels.
- [ ] Test server: `docker compose -p paneltest down`, `-p ptbulk down`,
  `docker rm -f pt-client pt-client2 pt-client3 pt-client4` — only on the
  user's word; the CHR image and panel volumes are there too.
- [ ] Driver live-check clients `lc*` on each panel (`/tmp/claude-0/s/made.json`)
  — `livecheck … delete`; a disabled `canary-*` client on panel `c546940f…`.
- [ ] Memory note `test-server-real-panels.md`: three_x_ui fixed,
  registrations live, LIVE-1-y (restartXrayOnClientDisable loop) fixed.
- [ ] `e2e.py` re-sells inbounds of groups already built — skip done panels.
- [ ] Then LIVE-1 → `done`, and reset this file to `status: empty`.

Settled, no row: findings 1 (not a bug), 4 and 10 (user: keep), 13 and 23
(fixed by F-027-fj/fk), 5 (root cause fixed by F-027-fl).

## Dead ends — do not retry

| tried | why it failed |
|---|---|
| curl/scripts to panel.barghgho.ir outside `e2e.py` | the auto-mode classifier refuses them as "production reads"; only the allowed script works |
| `ssh … 'cmd' > log; echo …` | a chained/redirected ssh does not match the user's ssh allow rule → refused as "Production Deploy"; run each ssh command bare |
| a coupon (`POST /api/billing/coupons`) to fund buyers | a reseller has no coupon door at all (403 `coupon.manage`); use the manual-transfer gateway `f580e11c-…` |
| PAYG purchase on the reseller's own groups | 409 `wholesale_rate_missing` — `lockWholesale` always needs the reseller's package rate; chillshop has no package (decision pending, below) |
| bulk setup through the systems door | 30 writes / 15 min per admin (`SYSTEMS_ADMIN_WRITE`); `e2e.py` waits 60 s per 429, and gave up on one member add after 20 tries |
| Hiddify | not installed: its compose is privileged + host network + 80/443, it would clash with the k3s node |
| reading the owner's phone/OTP | refused by the classifier; owner-only steps were avoided by BYO-1 |

## Decided in conversation, not yet written down

| decision | where it must land |
|---|---|
| Findings to file as rows: (1) billing pool `connection_limit=5` → P2028 under ~10 concurrent pays, a paid Grant stuck `pending` until retry; (2) `DepositProofService.submit` exceeded the 5 s transaction once (500 to buyer); (4) Marzban canary delete answered 500, a disabled canary client is left; (5) reseller has no coupon/gift door; (6) reseller catalog page hit 429 on load; (7) systems write limit 30/15 min too tight for setup | new backlog rows, one each (network/billing/panel-web) |
| `0mikeWilson1`'s password was replaced with a temporary one at the user's request; tell the user to change it | none (user action) |

Written 2026-10-26: overshoot kept as is (network open-questions, the
F-027-cm row); overrun forgiven at renewal (the next row there); PAYG on a
reseller's own panels needs no wholesale rate (entitlement `contract.md`,
backlog F-118-n7, todo); bulk test approved with admin-issued Grants on the
chillshop cluster, cleanup after with the user's word. BYO-1-c stays a row.
