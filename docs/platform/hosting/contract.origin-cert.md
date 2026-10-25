---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-25
---

# Contract — hosting: each door's origin certificate

ADR-0165 point 4: no origin certificate needs the foreign internet to stay
valid. The edges terminate the visitor's TLS; each door presents a long-lived
certificate to its own edge, and an alert fires 30 days before one ends. Rows
NIN-1-c1 (the domestic door, 8443). The doors themselves are
`contract.origin.md` (O3, O4, O12). Rule O13.

## The rule

**O13 — No door's certificate is renewed online.** `scripts/edge/origin-cert.sh
domestic <domain>` makes our origin CA once (20 years; its key bound by nothing,
so never sealed) and signs a 10-year server certificate for `<domain>` and
`*.<domain>` into `dev-docker/secrets/origin-cert/`; it replaces one only with
`FORCE=1`. A gateway names its pair in `EDGE_ORIGIN_CERT`, and
`dynamic/origin-cert.yml` loads `/etc/traefik/origin-cert/<name>.pem|.key`, bound
from that folder, so the pair is sealed (S1). It is never the default
certificate: an unknown SNI still gets Traefik's (O4), as does a reseller's host
on 8443, which Arvan takes unverified. The expiry is read from the Traefik that
serves it: `--metrics.prometheus` on the internal :8080 (no request series),
job `gateway-domestic`, `traefik_tls_certs_not_after`. `OriginCertExpiring`
(`database.rules.yml`) fires 30 days before the end, `OriginCertNotServed` when
the door answers with none of ours. Re-issue: `FORCE=1`, `secrets seal` the
pair, deploy. Proven 2026-10-25 on Traefik v3.7 with the real dynamic files:
the pair served for `panel.<domain>` beside O3 `required`, Traefik's own for a
reseller's host, the gauge carrying only ours; unset, nothing loaded, no error.
Tests: `scripts/edge/test_origin_cert.py`, `tools/k8s_render_traefik_test.py`
(domestic door), `database.rules.test.yml` (NIN-1-c1).
