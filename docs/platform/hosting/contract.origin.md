---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-25
---

# Contract — hosting: the origin answers only Cloudflare

ADR-0129 amendment 1 (D-70): no tunnel. The origin keeps 443 open, but only
Cloudflare can complete a handshake, and on the production host only Cloudflare's
addresses reach it. Rows EDGE-1-g (certificate, client address) and EDGE-1-h
(firewall), EDGE-1-k/m (a CDN's claim, amendment 2), EDGE-1-j (private
responses, decision 8). Rules O1…O11.

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
| `required` (any other value) | `RequireAndVerifyClientCert` | dev since 2026-10-07 (user), and prod at go-live. A typo fails closed. |

Options `default` hold for every router and for an unknown SNI. No router may
name other TLS options: they would bypass this.

**O4 — An unknown SNI gets no real certificate.** No `defaultCertificate` and
no `sniStrict`. With no SNI or a name we hold no certificate for, Traefik
serves its self-signed `TRAEFIK DEFAULT CERT`, so an address scan reads no host
name. `sniStrict` is not used because Cloudflare's pull for a Custom Hostname
carries that hostname as SNI, and we hold no certificate for it.

**O5 — The client address.** The local plugin `edgeclientip`
(`dev-docker/traefik/plugins-local/src/github.com/txnet/edgeclientip`, the
middleware `edge-client-ip@file`) runs on every router of both entrypoints
(`--entrypoints.*.http.middlewares`). When the connection's client chain
verified against O1's CA and `CF-Connecting-IP` is one IP address, that address
becomes `RemoteAddr` (from which Traefik's proxy writes `X-Forwarded-For`) and
`X-Real-Ip`, and any leftover `X-Forwarded-For` is dropped. In every case
`CF-Connecting-IP` itself is removed, so no service can read it. Services keep
`TRUST_PROXY=1` and change nothing. Per-caller rate limits (ADR-0070) then see
the visitor, not a Cloudflare edge.

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
`X-Forwarded-For`, websecure runs with `forwardedHeaders.insecure=true`, so
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

**O7 — Cloudflare's ranges only, production host.** `scripts/edge/cloudflare_firewall.py
apply` reads `https://api.cloudflare.com/client/v4/ips` and writes chain
`TXNET-EDGE` in one `iptables-restore --noflush` / `ip6tables-restore` commit:
`RETURN` per range, then `DROP`. The chain is reached from `INPUT`
(`--dports 80,443`), and from `FORWARD` and `DOCKER-USER`
(`--ctorigdstport 80|443`: a published port is DNATed before it is forwarded —
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
one edge, and `cloudflare_firewall.py apply` admits what it returns. A list under
its edge's floor, a malformed or wrong-family range, a range wider than /8 (v4)
or /16 (v6), or a failed answer is refused. That edge's last good copy
(`/var/lib/txnet/edge-ranges/<name>.json`, with when it was taken, held to
today's floors) is used instead, and with none the run fails and changes
nothing. Each copy's time is exported (`edge_ranges.prom`,
`txnet_edge_ranges_last_refresh_timestamp_seconds{edge}`), and `EdgeRangesStale`
(`database.rules.yml`) warns after 3 days. `cloudflare_firewall.py install`
writes `/etc/cron.d/txnet-cloudflare-firewall` (boot after Docker, daily 04:23),
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
`scripts/edge/test_cloudflare_firewall.py`, `test_edge_ranges.py`.

## ArvanCloud as the domestic edge — what it does (NIN-1-a, ADR-0165)

Proven 2026-10-25 on `nin.barghgho.ir` (a throwaway record, Arvan plan level 1)
to a stdlib TLS echo on the test server's 8443, the port admitted to Arvan's
ranges only; removed afterwards. Facts NIN-1-b and NIN-1-c build on:

| question | answer |
|---|---|
| Origin certificate | **not verified**: a self-signed one (no CA, SAN only) is accepted with `upstream_https: https`. Long-lived, no renewal, no foreign internet (ADR-0165 point 4) |
| Origin port | any, per record (`value[].port`); 443 stays Cloudflare's |
| Proof of Arvan to the origin | none below Enterprise: no client certificate is sent, custom headers are Enterprise-only. Ranges (`https://www.arvancloud.ir/en/ips.txt`, 14 IPv4 that day, domestic) are the only proof |
| Visitor address | `X-Real-IP`, `AR-Real-IP`, `True-Client-IP`: set by Arvan, a client's own value **overwritten**. `X-Forwarded-For` keeps a client's value and appends — never read its left end |
| Other headers | `X-Forwarded-Proto/-Port`, `AR-Real-Country`/`X-Country-Code`, `AR-Sid`, `CDN-Loop: arvancloud`; `Host` is the visitor's (`host_header: source`) |
| Caller seen at the origin | `94.101.182.2`, inside `94.101.182.0/27` of the list |
| WebSockets | pass (`101`, frames both ways). Idle 90 s kept, idle 200 s closed (Arvan's documented bound: 180 s between writes); gateway-service's heartbeat is 30 s (`REALTIME_HEARTBEAT_MS`), so it must stay under 180 s |
| Direct caller | a non-Arvan address on 8443 was dropped by the proof's chain |

So the Arvan door is its own entrypoint on its own port, admitted by range,
with no client-certificate requirement there (O3 keeps 443 on `required`). The
proof used host networking (`INPUT`); through servicelb the chain is also needed
in `FORWARD`, as O7 does.
