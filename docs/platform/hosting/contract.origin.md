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
(firewall). Rules O1…O8.

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
and another CA's certificate is still refused. The dev gateway runs the plugin
with `off`, and a forged `CF-Connecting-IP` is dropped there. O2 on `txnet.cyou`
is the user's step.
