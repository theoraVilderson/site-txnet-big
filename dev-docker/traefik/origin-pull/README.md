# Origin-pull CA (EDGE-1-g)

`scripts/edge/origin-pull.sh issue` writes `ca.pem` here — the gateway mounts
this folder — and the keys and client certificate to `dev-docker/secrets/origin-pull/`;
`upload` gives Cloudflare the client pair as the zone's Authenticated Origin
Pulls certificate. Neither is committed (`*.pem` in `.gitignore`). Contract:
`docs/platform/hosting/contract.origin.md`.
