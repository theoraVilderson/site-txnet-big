---
id: hosting
layer: platform
status: draft
version: 1
updated: 2026-10-07
---

# Contract — hosting: the origin answers only Cloudflare

ADR-0129 amendment 1 (D-70): no tunnel. The origin keeps 443 open, but only
Cloudflare can complete a handshake, and on the swarm host only Cloudflare's
addresses reach it. Rows EDGE-1-g (certificate, client address) and EDGE-1-h
(firewall), EDGE-1-k (a CDN's claim, amendment 2). Rules O1…O9.

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
| `optional` | `VerifyClientCertIfGiven` | dev: Cloudflare's pulls verify, direct callers still get in |
| `required` (any other value) | `RequireAndVerifyClientCert` | swarm. A typo fails closed. |

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
2031-10-06), and the dev gateway on `optional`. Through Cloudflare, `panel.<domain>`
and the Custom Hostname `edgetest.chillshop.ir` both arrive as verified pulls
with the caller's address. A direct call with a forged header keeps the socket's
address. **Behind a reseller's own CDN, the visitor Cloudflare names is that CDN's
edge** (Arvan, 185.215.232.x), so per-caller limits there count per CDN edge.

**O9 — A CDN's claim rides beside the address (EDGE-1-k).** Behind a
reseller's own CDN, O5's address is that CDN's edge. On a verified pull, the
plugin reads the first IP address in `claimHeaders` (in `origin-pull.yml`:
`True-Client-IP`, `AR-Real-IP`, `Fastly-Client-IP`). If it differs from the
address, the plugin writes it as `X-Edge-Claimed-Ip` (`EDGE_CLAIMED_IP_HEADER`).
It removes a client-sent `X-Edge-Claimed-Ip` and the listed headers on every
request, so services read one name only. The claim is never `req.ip`: only the
limiter counts it (redis-keyspace `contract.shared-address.md`). Adding a CDN
means adding its header to the list.

## The firewall (EDGE-1-h)

**O7 — Cloudflare's ranges only, swarm host.** `scripts/edge/cloudflare_firewall.py
apply` reads `https://api.cloudflare.com/client/v4/ips` and writes chain
`TXNET-EDGE` in one `iptables-restore --noflush` / `ip6tables-restore` commit:
`RETURN` per range, then `DROP`. The chain is reached from `INPUT`
(`--dports 80,443`) and `DOCKER-USER` (`--ctorigdstport 80|443`: a published
port is DNATed before `FORWARD`). Both match only the public interface
(`EDGE_PUBLIC_IFACE`, default the default route's), so bridges and the tailnet
are never filtered. Re-running adds no second jump. `remove` undoes it, and
`print` shows the rules without changing anything.

**O8 — Kept in step, never emptied.** A list with fewer than 10 IPv4 or 5 IPv6
ranges, a malformed or wrong-family range, a range wider than /8 (v4) or /16
(v6), or a failed answer is refused. The last good list
(`/var/lib/txnet/cloudflare-ips.json`) is used instead, and with none the run
fails and changes nothing. `install` writes `/etc/cron.d/txnet-cloudflare-firewall`:
at boot (after Docker) and daily at 04:23. Dev does not run it.
Proven 2026-10-07 in an empty network namespace: the cached list was used,
re-applying kept one jump, a non-Cloudflare caller on 443 was dropped, and
`remove` restored it. Tests: `scripts/edge/test_cloudflare_firewall.py`.
