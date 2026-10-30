---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-30
---

# Contract — hosting: staging's copy of production holds nothing real, and the owner's way in

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
- **People** (OPS-1-ah-g, `tools/k8s_staging_people.py`). Every column in its
  `COLUMNS` table is rewritten, numbered row by row: phones become
  `+98912` + 7 digits (the ADR's 0912000xxxx, stored as E.164), emails
  `user<n>@staging.invalid`, Telegram and Bale chat ids `9000000000000000 + n`
  (past Telegram's 52-bit ids, still a safe JS integer), a masked card
  `000000******0000`. A manual destination's card, sheba, holder, wallet address
  and memo (in `fields` and every payment's `destinationSnapshot`) get fakes
  that pass the kinds' own checks (Luhn, mod 97), a deposit address
  `staging-wallet-0000000000`, a reseller's support phone and email the same
  fakes, an imported user's `telegramLink` null, and a migration's
  `sourceAddress` the wiped origin. A unique column is first moved aside
  (`~` + itself), so a fake never meets a real value not yet rewritten.
  `identity.otp_code` is emptied. In Redis, the `bot:`, `botlink:` and `otp:`
  families (after the client's `txnet:<app>:v<n>:` prefix) and any key with a
  segment that is a `+` phone, digits alone or an email are deleted. A UUID's
  digits don't count: deleting an outbox `processed` key would send a notice
  twice. `redis-cli` runs in memory-data's pod and reads the pod's own
  `REDISCLI_AUTH` (`data.yml`, K5), so no password passes through the scrub. RabbitMQ's queued messages, which the restore would publish back
  once the services start, are dropped: they were addressed to real people.
  Message bodies (support tickets, notices) are content, not a contact, and stay.
- **Keys** (OPS-1-ah-h, `tools/k8s_staging_keys.py`). Every vault row but
  `panel_credentials` (the panels' rule above) is deleted, whatever its kind:
  bots, webhook secrets, SMS, gateways, AI, DNS. So an SMS stays `queued` and
  an online gateway answers "not configured"; buying is tested by card-to-card,
  which needs no key (user, 2026-10-29: no SMS stub, no sandbox; billing refuses
  `PAYMENT_GATEWAY_SANDBOX` under `NODE_ENV=production`, and the sandboxes are
  out of reach anyway). The encrypted merchant id and key on
  `tenant_gateway_config` are cleared, and the never-read `payment_gateway.merchantId`
  becomes `wiped`. The platform's primary Telegram and Bale bots become the dev
  bots of `.env.dev` (`<PLATFORM>_BOT_TOKEN`, `_BOT_USERNAME`, `_WEBHOOK_SECRET`,
  as `seed-bot-integration.sh` reads them; an unset secret is derived from the
  token). Their token and secret are sealed as `vault.crypto.ts` seals, under a
  new data key wrapped with the KEK that tenant-service mounts, read from the
  cluster into memory. Nothing of production's is unwrapped. Every other bot is
  `disabled`. A platform whose token `.env.dev` lacks has no bot. One token answers
  one webhook, so only the platform's bot can be the dev bot.
- **The guard.** It reads every panel row and the vault. It refuses, naming
  each one: an address field (`apiBaseUrl`, `clientBaseUrl`, `ipAddress`,
  `knownAddresses`) naming a host that is neither a local panel nor 192.0.2.1;
  any `ovpnProfile`; a wiped panel still holding a login or still in service;
  a vault login of no local panel (a deleted panel's counts); and any source
  panel's login. For people, it refuses any value in a `COLUMNS` column that
  is not a fake, any OTP row, and any text, json or array column whose name
  says contact (phone, mail, chat, card, sheba, address, wallet …) that neither
  `COLUMNS` nor `NOT_CONTACT` lists. For keys, it refuses a vault row that is
  not the platform's and sealing a dev bot's value (by fingerprint), a bot not
  `disabled` that is not the platform's primary under the dev bot's name, a
  gateway's key or merchant id, and a column named like a key (secret, token,
  api key, merchant, password, sealed …) that neither `KEY_COLUMNS` nor
  `NOT_KEY` lists. A migration that adds one therefore stops
  the twin. The twin runs it again after the new release's migration,
  before its checks (R14), and only panels in service there are counted as
  collected from.
- **A new contact column** (a panel address, a channel, a gateway) is added to
  the scrub and the guard in the same change, or the guard misses it
  (ADR-0168, consequences).

**R17 — The owner reaches staging through ssh, and only staging** (ADR-0168
point 3, OPS-1-ah-i, `tools/k8s_staging_open.py`). `staging.sh open [--port 8443]`,
while staging holds production's data:

- **The proxy** listens on this host's loopback only; the owner's computer
  reaches it by `ssh -N -L`. A browser profile kept for staging uses it as its
  HTTP and HTTPS proxy. Each `CONNECT host:443` is answered with a certificate
  for that host, and its bytes go to staging's Traefik through a `kubectl
  port-forward` (the smoke check's, re-opened when it ends) by the host's own
  SNI, presenting the origin-pull pair (O3), so Traefik sees a verified pull as
  from Cloudflare. A plain-http request is redirected to https. Any other request is refused. The
  proxy has no other upstream: nothing the profile asks for reaches the internet.
- **Its CA.** The panel sends HSTS, so a certificate cannot be clicked past.
  `/var/lib/txnet/staging-ca` holds a CA made once (key owner-only, kept
  across `down`), which the owner imports into that profile once. Host
  certificates are signed per run, in memory. Only that profile trusts it.
- **The pull pair** opens with production's age key, linked only while staging
  holds its data (`restore`/`twin`), into `/dev/shm`, removed at exit. Without it,
  `open` refuses.
- What the owner changes lives in the copy and goes at `down`.

## Proof

`tools/k8s_staging_scrub_test.py` (14), `k8s_staging_people_test.py` (9),
`k8s_staging_keys_test.py` (16), `k8s_staging_open_test.py` (8), `k8s_staging_data_test.py`,
`k8s_staging_twin_test.py`, `scripts/bundle/test_bundle.py`
(`test_a_scrub_that_refuses_the_copy_stops_the_restore_before_the_services`).
2026-10-29, the SQL run on dev's database inside a transaction that was rolled
back: 4 panels, 1 pointed and 3 wiped; 5 findings before (including a deleted
panel's login left in the vault), none after; every constraint held. That run
found `panel_api_address_key`, which is why each wiped address ends in its id.
People, 2026-10-29, on dev: the SQL inside a rolled-back transaction, 8 columns
holding real values before (57 OTP codes, 27 phones, cards, shebas, chat ids),
none after, and no contact column unknown. Redis's scan picked 4 of 3402 keys
(`bot:session`, `bot:lang`); the first pattern, which matched any 10-digit run,
would have caught outbox UUIDs. The delete path was checked on a key made for it.
Live, 2026-10-29, `twin --from 21c9d8f8` over production's 08:51 bundle: panels
6 pointed and 4 wiped; people 13 columns faked, OTP emptied, no Redis key or
queued message to drop; the guard clean before the services and again after
the new release's migration; ready 35/35, 6 panels collected, roll 0 of 2522,
stores back. Its first try stopped at the scrub with every service down:
production's memory-data has no `--requirepass` argument (K5), so redis-cli now
uses the pod's own `REDISCLI_AUTH`.
Keys, 2026-10-30, on dev: the SQL inside a rolled-back transaction, 7 real
vault keys (gateways, SMS) and 2 merchant ids before, none after, both dev bots
`active` and every constraint held. A value Python sealed, under a DEK it
wrapped, opened through `vault.crypto.ts` itself, and the fingerprints matched.
Open, 2026-10-30, against dev's Traefik (O3 `required`) with dev's pull pair:
the panel and the apex 200 through the proxy, curl verifying the staging CA's
certificate; a client pair of another CA refused at the handshake. Not yet run
against staging itself.
