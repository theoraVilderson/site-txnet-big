---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-26
---

# Contract — hosting: the origin certificate

ADR-0165 point 4: no origin certificate needs the foreign internet to stay
valid. The edges terminate the visitor's TLS; the origin presents one
long-lived certificate to every edge on 443, and an alert fires 30 days before
it ends. Row NIN-1-c2; NIN-1-c1's own certificate for the domestic door went
with its port (NIN-1-b4: Arvan verifies none, NIN-1-a). The door itself is
`contract.origin.md` (O3, O4, O12). Rule O13.

## The rule

**O13 — The origin certificate is never renewed online.** It is a file issued once
by `scripts/edge/origin-cert.sh` into `dev-docker/secrets/origin-cert/`, which
replaces one only with `FORCE=1`:

| served by | command | issuer, life | names |
|---|---|---|---|
| 443, `gateway-handler` | `cloudflare` | Cloudflare's Origin CA, from our CSR (the key never leaves the host), 15 years | `<DOMAIN_NAME>`, `*.<DOMAIN_NAME>` |

`cloudflare` and `strict` read the EDGE-1-c token (Zone / SSL and Certificates /
Edit), the zone and `DOMAIN_NAME` from `ENV_FILE`; a refused answer writes
nothing. `strict` puts the zone on Full (strict), so Cloudflare verifies the
certificate on every pull (set by the user 2026-10-25).

**Served.** The gateway names its pair in `EDGE_ORIGIN_CERT`;
`dynamic/origin-cert.yml` loads `/etc/traefik/origin-cert/<name>.pem|.key`,
bound from that folder, so the pair is sealed (S1) and carried by a move and a
bundle (`move_plan.py` `CARRIED_FILES`). With `EDGE_ORIGIN_CERT_DEFAULT=true`
it is the default certificate, served for every name: a Custom Hostname's
pull carries the reseller's domain as SNI, and Full (strict) accepts a
certificate for the fallback origin (`edge-origin.<domain>`, under the
wildcard). Arvan takes it unverified for a domestic domain's names (O4).

**Nothing fetches one.** Traefik has no certificate resolver, no `acme.json`, no
`letsencrypt` claim; `k8srender` refuses a route naming a `tls.certresolver`,
and `k8s_render_traefik_test.py` holds every tracked compose and dynamic file
free of one. A route that wants TLS says `tls=true` and gets the pair.

**Alerted.** The expiry is read from the Traefik that serves it:
`--metrics.prometheus` on the internal :8080 (no request series), job
`gateway-handler`, `traefik_tls_certs_not_after`.
`OriginCertExpiring` (`database.rules.yml`) fires 30 days before the end,
`OriginCertNotServed` when the gateway answers with none of ours (every
Cloudflare pull is then refused: 526). Re-issue: `FORCE=1 origin-cert.sh
cloudflare`, `secrets seal` the pair, commit, deploy.

**Proof.** 2026-10-25 on Traefik v3.7 with the real dynamic files: the domestic
pair served for `panel.<domain>` beside O3 `required` and Traefik's own for a
reseller's host; with `EDGE_ORIGIN_CERT_DEFAULT=true`, the pair for a platform
host, a reseller's host and no SNI; the gauge carrying only ours each time;
unset, nothing loaded, no error. The 443 certificate issued for `txnet.cyou`
(to 2041-10-21) and sealed, as was the domestic one for `barghgho.ir`. Live
on the test server the same day (release `d174c885`), the zone on Full
(strict): `panel.txnet.cyou` 200, and the Custom Hostnames `panel.barghgho.ir`
and `edgetest.chillshop.ir` 200, so Cloudflare accepts the fallback origin's
certificate for a reseller's SNI (526 for all three before the release, when
the origin served Traefik's own); 8443 served the domestic pair; Prometheus
read both gauges, `up` 1 on both jobs.
Tests: `scripts/edge/test_origin_cert.py`, `tools/k8s_render_traefik_test.py`,
`database.rules.test.yml`.
