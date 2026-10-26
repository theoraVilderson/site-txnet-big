---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-26
---

# Contract — hosting: the origin answers only the approved edges

ADR-0129 amendment 1 (D-70): no tunnel. The origin keeps 80/443 open, but on
the production host only the approved edges' addresses reach it, and past that
each edge proves itself: Cloudflare by our certificate, a domestic edge by its
ranges (ADR-0165 amendment 2, NIN-1-b4: one door, no 8443). Rows EDGE-1-g (certificate, client address) and EDGE-1-h
(firewall), EDGE-1-k/m (a CDN's claim, amendment 2), EDGE-1-j (private
responses, decision 8), the domestic edges on the same door (NIN-1-b4, O12), the certificate
(NIN-1-c2, O13 in `contract.origin-cert.md`), the domestic domain's records
(NIN-1-d1, O14). Rules O1…O12, O14.

## The pull certificate (EDGE-1-g)

**O1 — Our own CA, never Cloudflare's shared one.** Any Cloudflare customer can
make Cloudflare present the shared origin-pull certificate, so trusting it
admits anyone with a free zone. `scripts/edge/origin-pull.sh issue` makes an
RSA-2048 CA (10 years) and one client certificate (`extendedKeyUsage=clientAuth`,
5 years). `ca.pem` goes to `dev-docker/traefik/origin-pull/`, which the gateway
mounts. The CA key and the client pair go to `dev-docker/secrets/origin-pull/`,
which it does not mount. None is committed.

**O2 — Zone-level Authenticated Origin Pulls.** `origin-pull.sh upload` posts
the client pair to `zones/<id>/origin_tls_client_auth` and sets
`origin_tls_client_auth/settings` `enabled: true` (token: Zone / SSL and
Certificates / Edit, the EDGE-1-c token). `status` shows both. Zone-level AOP
covers every proxied host of the zone, so Custom Hostnames sent to the fallback
origin present it too. Rotating means issuing with `FORCE=1`, uploading, then
restarting the gateway. Until the restart, the gateway still trusts the old CA.

**O3 — The switch, `EDGE_ORIGIN_PULL`** (gateway env, read by the Go template
`dev-docker/traefik/dynamic/origin-pull.yml` into TLS options `default`):

| value | `clientAuthType` | used on |
|---|---|---|
| `off` (unset) | none: no certificate asked | before O2 is done |
| `optional` | `VerifyClientCertIfGiven` | Cloudflare's pulls verify, direct callers still get in (dev until 2026-10-07) |
| `required` (any other value) | `VerifyClientCertIfGiven`, and the plugin's `requirePull` | dev since 2026-10-07 (user), and prod at go-live. A typo fails closed. |

On `required` the handshake only asks, since a domestic edge has no certificate
(NIN-1-a); `edgeclientip` then refuses (403) a TLS request that is neither a
verified pull nor from a domestic edge's ranges (O12). Another CA's certificate
is still refused at the handshake. Options `default` hold for every router and
for an unknown SNI. No router may name other TLS options: they would bypass this.

**O4 — An unknown SNI gets the Origin CA certificate (O13); no `sniStrict`.**
The default is Cloudflare's Origin CA certificate (NIN-1-c2), which a domestic
edge takes unverified: a Custom Hostname's pull carries that hostname as SNI, and Full
(strict) refuses Traefik's own; a scan there must come from Cloudflare (O7) and
reads only `<domain>`, which DNS publishes anyway. `sniStrict` is not used for
the same reason: we hold no certificate naming a Custom Hostname.

**O5 — The client address.** The local plugin `edgeclientip`
(`dev-docker/traefik/plugins-local/src/github.com/txnet/edgeclientip`, the
middleware `edge-client-ip@file`) runs on every router of both entrypoints
(`--entrypoints.*.http.middlewares`). When the connection's client chain
verified against O1's CA and `CF-Connecting-IP` is one IP address, that address
becomes `RemoteAddr` (from which Traefik's proxy writes `X-Forwarded-For`) and
`X-Real-Ip`, and any leftover `X-Forwarded-For` is dropped. In every case
`CF-Connecting-IP` itself is removed, so no service can read it. Services keep
`TRUST_PROXY=1` and change nothing. Per-caller rate limits (ADR-0070) then see
the visitor, not a Cloudflare edge. From a domestic edge's ranges it reads
`visitorHeader` instead, and nothing else names the visitor there (O12). It also sets `X-Edge-Door`
(`cloudflare` on a verified pull, `domestic` from those ranges, else `direct`) over a client's, for the domain check (NIN-1-e2).

**O6 — Proof** (2026-10-07, throwaway Traefik v3.7, same files):

| `required` | result |
|---|---|
| no certificate | handshake refused |
| client certificate from another CA (stands in for the shared one) | handshake refused |
| our certificate + `CF-Connecting-IP: 5.6.7.8` | `X-Forwarded-For: 5.6.7.8`, `X-Real-Ip: 5.6.7.8`, no `CF-Connecting-IP` |
| no SNI, an unknown SNI, a routed host | `CN = TRAEFIK DEFAULT CERT` |

With `optional`, no certificate reaches the router with the socket's address,
and another CA's certificate is still refused.

Live on dev, 2026-10-07: O2 done on `txnet.cyou` (certificate `active`, expires
2031-10-06), and the dev gateway on `optional`, then on `required` (user, same day).
On `required`, Cloudflare, Arvan -> Cloudflare, barghgo's bot host and the internal
`http://api.<domain>` hop all answer 200. A direct handshake without the certificate is refused. Through Cloudflare, `panel.<domain>`
and the Custom Hostname `edgetest.chillshop.ir` both arrive as verified pulls
with the caller's address. A direct call with a forged header keeps the socket's
address. **Behind a reseller's own CDN, the visitor Cloudflare names is that CDN's
edge** (Arvan, 185.215.232.x), so per-caller limits there count per CDN edge.

**O9 — A CDN's claim rides beside the address (EDGE-1-k, EDGE-1-m).** Behind
a reseller's own CDN, O5's address is that CDN's edge. On a verified pull, the
plugin takes the claim from the first IP in `claimHeaders` (`origin-pull.yml`:
`True-Client-IP`, `AR-Real-IP`, `Fastly-Client-IP`, `X-Azure-ClientIP`,
`CloudFront-Viewer-Address`, the last as `ip:port`). With none of those, it
reads `X-Forwarded-For`: Cloudflare appends the edge it saw, and the CDN
appended the visitor just before. So the claim is the entry before the last,
and only when the last is `CF-Connecting-IP`. A claim that differs from the
address is written as `X-Edge-Claimed-Ip` (`EDGE_CLAIMED_IP_HEADER`). A
client-sent one and the listed headers are removed on every request. The claim
is never `req.ip`: only the limiter counts it (redis-keyspace
`contract.shared-address.md`). Adding a CDN with a header of its own means
adding the header to the list. Any other CDN already works through
`X-Forwarded-For`.

**O10 — The plugin makes every forwarded header (EDGE-1-m).** To read
`X-Forwarded-For`, websecure — and web, for a domestic edge's `X-Real-IP` on
80 (NIN-1-b4) — run with `forwardedHeaders.insecure=true`, so
Traefik keeps whatever a request arrives with. The plugin therefore drops every
`X-Forwarded-*` and `X-Real-Ip` on every request and rewrites them from the
request itself:
- `Host` -> `X-Forwarded-Host`, which services read to choose the tenant.
- `http`/`https`/`ws`/`wss` -> `X-Forwarded-Proto`.
- The `Host` port, else 443/80 -> `X-Forwarded-Port`.
- The socket address, or O5's -> `X-Real-Ip`.

`X-Forwarded-For` is left empty for Traefik's proxy to fill with the address.
`-Server`, `-Prefix`, `-Uri`, `-Method` and `-Tls-Client-Cert*` are dropped:
ForwardAuth computes its own (`trustForwardHeader` is off). The flag never goes
on an entrypoint without this middleware. Proven 2026-10-07 on a throwaway
Traefik and on dev: a forged `X-Forwarded-Host` arrives as the real host, a
chain sent without a certificate yields no claim, and Arvan -> Cloudflare
carries `104.248.193.151` as the claim.

**O11 — A signed-in caller's response is never shared (EDGE-1-j, ADR-0129
decision 8).** The local plugin `privatecache` (middleware `private-cache@file`,
after `edge-client-ip@file` on both entrypoints) sets `Cache-Control: private,
no-store` on a response when the request carried `Authorization` or a cookie
named in `contracts/http/wire.json` `cookies` (its test holds the two equal),
or the response sets a cookie, **and** the service set no `Cache-Control`. A
service's own rule always wins; a cookie that is not a credential (`theme`,
locale) changes nothing; a `101` is never marked, and the writer keeps
`Hijack`/`Flush`, so the realtime socket and SSE pass. A CDN that ignores the
header is caught by tenant `contract.domains.md`'s `cache` probe, not here.
Proven on dev 2026-10-07 through `http://api.<domain>`: anonymous billing 401
unmarked, bearer or `device_id` marked, auth-service's `device_id` Set-Cookie
marked, `/realtime` still `101`. Tests: `privatecache_test.go`.

## The firewall (EDGE-1-h)

**O7 — 80/443 admit every approved edge, production host.** `scripts/edge/edge_firewall.py
apply` re-reads every edge (O8) and writes the chain `TXNET-EDGE` for 80/443 —
Cloudflare and the domestic edges alike — in one `iptables-restore --noflush` /
`ip6tables-restore` commit: `RETURN` per range, then `DROP`, and unhooks NIN-1-b2's
`TXNET-DOMESTIC` (8443) where a node still has it. The chain is reached from `INPUT`
(`--dports` its ports), and from `FORWARD` and `DOCKER-USER`
(`--ctorigdstport <port>`: a published port is DNATed before it is forwarded —
k3s's servicelb through `FORWARD`, Docker's through `DOCKER-USER`; a chain the
host lacks is skipped). All match only the public interface
(`EDGE_PUBLIC_IFACE`, default the default route's), so bridges and the tailnet
are never filtered. Every run puts the jumps ahead of the chain's other rules
(K13's `TXNET-K3S` jumps aside: disjoint ports, `scripts/edge/edge_chain.py`) —
a rule above ours (k3s's, Docker's) decides first — copying before deleting, so
the chain is never unhooked; re-running adds no second jump. `remove` undoes it,
and `print` shows the rules without changing anything.

**O8 — Kept in step, never emptied; one list of edges (NIN-1-b1).**
`scripts/edge/edges.json` lists every approved edge: its name, where its ranges
are read and in which format (`cloudflare-api`, `lines`), the header it names
the visitor in, and the fewest IPv4/IPv6 ranges a real answer has (Cloudflare
10/5, Arvan 10/0). `edge_ranges.py` is the only fetcher: `ranges(name)` re-reads
one edge, `edge_firewall.py apply` admits them all, and the gateway reads the
domestic edges' copies (O12). A list under
its edge's floor, a malformed or wrong-family range, a range wider than /8 (v4)
or /16 (v6), or a failed answer is refused. That edge's last good copy
(`/var/lib/txnet/edge-ranges/<name>.json`, with when it was taken, held to
today's floors) is used instead; with none, the chain is left as it was. Each copy's time is exported (`edge_ranges.prom`,
`txnet_edge_ranges_last_refresh_timestamp_seconds{edge}`), and `EdgeRangesStale`
(`database.rules.yml`) warns after 3 days; `EdgeRangesNeverRecorded`, on
Kubernetes only (the kubelet's job), when none was ever written. `edge_firewall.py install`
writes `/etc/cron.d/txnet-edge-firewall` (boot after Docker, daily 04:23; it
deletes the entry of its former name, `cloudflare_firewall.py`),
and `edge_ranges.py install` writes `txnet-edge-ranges`, which re-reads every
edge (boot, daily 04:13). `join` copies the list and the server's copies. Dev
does not run it. A new edge is a row of the list; a new answer format, a parser
in `PARSERS`.
Proven 2026-10-07 in an empty network namespace: the cached list was used,
re-applying kept one jump, a non-Cloudflare caller on 443 was dropped, and
`remove` restored it. The k3s path (OPS-1-o-g), proven 2026-10-24 the same way
with 443 DNATed to a stand-in pod: a non-Cloudflare caller dropped, a Cloudflare
one served, an `ACCEPT` for the pod range inserted above ours let the caller in
until the next `apply` put the jumps back on top. Tests:
`scripts/edge/test_edge_firewall.py`, `test_edge_ranges.py`.

## The domestic edges (NIN-1-b4, ADR-0165 amendment 2)

**O12 — A domestic edge is known by its ranges, on the same 443 and 80.** No
second Traefik and no 8443 (NIN-1-b2's, reversed 2026-10-26: a reseller's Arvan
left on its default port timed out). `edgeclientip` reads `edgeRangeFiles` —
`EDGE_RANGE_FILES`, the last good copies O8 keeps for the firewall, bound
read-only from the data node — re-stating them at most once a minute and
keeping the last good read of a copy that is missing or broken. A request with
no verified chain from inside them is that edge's: the client address is the
one header its edges name in `edges.json` (`EDGE_VISITOR_HEADER`, Arvan's
`X-Real-IP`, which Arvan overwrites); `CF-Connecting-IP`, the claim headers, a
client's `X-Edge-Claimed-Ip` and `X-Forwarded-For` (Arvan keeps a client's) are
dropped and no claim is made; a missing or malformed value leaves the socket's.
A verified pull stays Cloudflare's whatever its address. The render test holds
the header and the files equal to the list (NIN-1-b4). Never Cloudflare's ranges
in these files: a zone without our certificate would pass as an edge.

**O14 — The domestic domain's records are code** (NIN-1-d1). `edge_zone.py arvan
plan|apply|repoint|status` (`arvan_zone.py`) makes `api.`, `panel.`, `sub.` of
`DOMESTIC_DOMAIN_NAME` — the doors `seed-platform-doors.js` seeds, held equal by the test; `pay.`
dropped (user, 2026-10-25) — as A records to `EDGE_ORIGIN_IP`:443 (8443 until NIN-1-b4; `apply` moves them), cloud on,
upstream HTTPS, TTL 120, and the domain's edge certificate on. An A record keeps the
visitor's `Host`. A record is its own only in that shape: anything else on a door
name is refused, other names are never changed (the zone holds the user's site and
bots), and the cloud off on the origin's address is warned — except `*.edge`, an A record
to it with the cloud **off** on purpose: a reseller's own Arvan account points there
(tenant `contract.domain-path.md`, NIN-1-e1). Key: `dev-docker/secrets/arvan/api-key` (one domain),
sealed (S1 `tool_files`). Applied on barghgho.ir 2026-10-25 (each door 200 through Arvan); `*.edge` 2026-10-26.

Proven 2026-10-25 for the two-door design (Traefik v3.7, network namespaces); the
one door's proof is NIN-1-b4's note. Tests: `test_edge_firewall.py`,
`tools/k8s_render_traefik_test.py`, `edgeclientip_test.go`.

## ArvanCloud as the domestic edge — what it does (NIN-1-a, ADR-0165)

Proven 2026-10-25 on `nin.barghgho.ir` (a throwaway record, Arvan plan level 1)
to a stdlib TLS echo on the test server's 8443, the port admitted to Arvan's
ranges only; removed afterwards. Facts NIN-1-b and NIN-1-c build on:

| question | answer |
|---|---|
| Origin certificate | **not verified**: a self-signed one (no CA, SAN only) is accepted with `upstream_https: https`. Long-lived, no renewal, no foreign internet (ADR-0165 point 4) |
| Origin port | any, per record (`value[].port`); 443 by default, which is ours since NIN-1-b4 |
| Proof of Arvan to the origin | none below Enterprise: no client certificate is sent, custom headers are Enterprise-only. Ranges (`https://www.arvancloud.ir/en/ips.txt`, 14 IPv4 that day, domestic) are the only proof |
| Visitor address | `X-Real-IP`, `AR-Real-IP`, `True-Client-IP`: set by Arvan, a client's own value **overwritten**. `X-Forwarded-For` keeps a client's value and appends — never read its left end |
| Other headers | `X-Forwarded-Proto/-Port`, `AR-Real-Country`/`X-Country-Code`, `AR-Sid`, `CDN-Loop: arvancloud`; `Host` is the visitor's (`host_header: source`) |
| Caller seen at the origin | `94.101.182.2`, inside `94.101.182.0/27` of the list |
| WebSockets | pass (`101`, frames both ways). Idle 90 s kept, idle 200 s closed (Arvan's documented bound: 180 s between writes); gateway-service's heartbeat is 30 s (`REALTIME_HEARTBEAT_MS`), so it must stay under 180 s |
| Direct caller | a non-Arvan address on 8443 was dropped by the proof's chain |

So Arvan is admitted by range, with no client certificate, on the same
443 (O12); the chain is needed in `FORWARD` too through servicelb, as O7 does.
