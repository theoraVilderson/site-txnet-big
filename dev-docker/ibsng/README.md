# ibsng — a real IBSng for dev (F-027-ay-a)

IBSng A1.24, the last open-source release (SourceForge, 2008), built from its
released tarball, which is pinned by sha256. It is the install the `ibsng`
driver's wire shapes are proved on (`docs/domains/network/contract.ibsng.md`,
ADR-0160 decisions 5 and 13). Dev only: `docker-compose.dev.yml`, profile
`ibsng`, so a plain `up` never starts it.

```bash
scripts/dev.compose.sh --profile ibsng up -d --build ibsng   # starts ibsng-db too
docker logs -f txnet-dev-ibsng   # "ibsng: ready" in about ten seconds
```

| What | Where |
|---|---|
| XML-RPC | `http://ibsng:1235/` on `private_backend_network`, admin `system` / `IBSNG_SYSTEM_PASSWORD` (default `txnet-dev-ibsng`) |
| RADIUS | 1812 / 1813 udp; a NAS must be a RAS in IBSng first (`ras.addNewRas`) |
| Database | the `ibsng-db` service (Postgres 18), database `IBSng`, user `ibs`; volume `ibsng_db_data`. Remove the volume for a clean install |
| Logs | `/var/log/IBSng/` in the container; `ibs_error.log` has every refused call's traceback |

The first start against an empty database does what `scripts/setup.py` does
by hand: it imports the tables, functions, initial rows and compiled
settings, and sets the `system` password.

## What it took to run 2008 code

Each change keeps IBSng's behaviour; it only replaces what a 2008 distro gave
it. A field install has these by construction.

- **Python 2.7**, not the 2.4 it was written for. Two files have non-ASCII
  bytes and no encoding line; 2.4 read them as latin-1, and
  `declare-latin1.py` says so for 2.7.
- **PyGreSQL 4.2.2**: IBSng calls `pg.connect` with seven positional
  arguments, which 5.0 no longer takes. `pg.set_decimal(float)` restores the
  floats PyGreSQL 3 returned, because xmlrpclib cannot send a `Decimal`.
- **`standard_conforming_strings = off`** on the database: IBSng quotes with
  backslashes.
- **`/usr/bin/python`**: the addons (the script wrapper, the MikroTik
  `ssh_wrapper` that ends a session on the NAS) name it in their first line.
- **`IBS_SERVER_IP = 0.0.0.0`** instead of 127.0.0.1, so the driver can reach
  the XML-RPC server across the network.

## Re-proving what F-027-ay-a found

```bash
docker exec txnet-dev-ibsng python /usr/local/bin/probe.py
```

Eighteen checks, `ok:` or `FAIL:` each, about 45 seconds. Most of that is
waiting for IBSng's 30-second re-check to end a session over its limit. The
probe plays the NAS with `radclient`, against a `Mikrotik` RAS at 127.0.0.1
with SNMP off. It makes the `txnet` charge, group and RAS if they are missing,
and deletes its own users at the end. A `FAIL` means this IBSng answers
differently from a rule the driver relies on: read the rule in
`contract.ibsng.md` before changing the check.
