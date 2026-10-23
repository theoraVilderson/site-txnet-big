# routeros-chr — a real Mikrotik User Manager for dev (F-1601-e)

A RouterOS v7 CHR with the User Manager package, run under qemu. It is the
router the `usermanager` driver's wire shapes are proved on
(`docs/domains/network/contract.usermanager.md` rules 8-12). Dev only:
`docker-compose.dev.yml`, profile `routeros`, so a plain `up` never starts it.

```bash
scripts/dev.compose.sh --profile routeros up -d --build --no-deps routeros-chr
docker logs -f txnet-dev-routeros-chr   # "chr: ready" after a minute or two
```

This host has no `/dev/kvm`, so qemu emulates: the first boot installs User
Manager and reboots (about two minutes), and later boots take about one. The
disk is the `routeros_chr_data` volume; remove it for a clean router.

| What | Where |
|---|---|
| REST root | `http://routeros-chr` on `private_backend_network` (from the host: the container's address), `admin` / `CHR_ADMIN_PASSWORD` (default `txnet-dev-chr`) |
| RouterOS version | `ROUTEROS_VERSION` build arg, default `7.24.5` |
| User Manager | enabled, `use-profiles=yes` (bootstrap.sh); a RADIUS client `probe` for 10.0.2.2, secret `CHR_RADIUS_SECRET` |

## Re-proving what F-1601-e found

```bash
docker exec txnet-dev-routeros-chr sh /usr/local/bin/probe.sh
```

Eight checks, `ok:` or `FAIL:` each, about 40 seconds. It talks RADIUS to User
Manager with `radclient` (the container is 10.0.2.2 to the guest) and, for the
accounting check, makes the CHR its own NAS (`nas.sh`: an OpenVPN server, User
Manager as the first `/radius` entry, `acct-probe.conf`'s FreeRADIUS as the
second). A `FAIL` means RouterOS changed under a rule the driver relies on:
read the rule it names before changing the check.

The driver against the same router:

```bash
cd network-service && env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy \
  USERMANAGER_LIVE_URL=http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' txnet-dev-routeros-chr) \
  USERMANAGER_LIVE_PASSWORD=txnet-dev-chr go test -count=1 -run OnARealRouter ./internal/driver/usermanager/
```

The host's proxy variables are unset because Go's HTTP client would send the
request to the proxy, which answers 503 for a private address.
