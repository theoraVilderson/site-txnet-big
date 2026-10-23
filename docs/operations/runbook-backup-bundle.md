---
id: runbook-backup-bundle
status: active
updated: 2026-10-23
---

# Runbook — the backup bundle: make it, ship it, bring it back

One encrypted file holds the whole platform: every database, Redis (so nobody
is signed out), the queued messages, uploaded files, runtime-written text, the
keys and env files. Made nightly and on demand without stopping anything; sent
to S3 by a separate script with a key that cannot delete. Hosting
`contract.bundle.md` B1…B9; code `scripts/bundle/`.

```bash
BACKUP="python3 scripts/bundle/backup.py --stack dev"     # prod: --stack prod
```

Measured 2026-10-23 on dev (240 tables, 1426 users, 8210 Redis keys): a bundle
in **16s, 41 MB**; `verify` in **45s**; shipping one to S3 (MinIO
rehearsal, write-only key) in **3s**.

## Symptom

You want a copy of everything right now (before a risky change, before a
move), or the server is gone and you have a bundle from S3.

## How it pages

`BackupBundleStale` (critical): no bundle in 26h — `journalctl -u
txnet-backup.service`. `BackupBundleNotShipped` (warning): two or more not in
S3 for an hour — shipping is failing, or was never set up (below).

## First 3 checks

1. **The passphrase is kept off this server.** `dev-docker/secrets/backup-bundle-passphrase`
   opens every bundle; a copy of it lives in your password manager. Without it a
   bundle in S3 is noise. It is never inside a bundle.
2. **`$BACKUP list`**: the bundles here, and which reached S3.
3. **Shipping is set up** (once): a bucket; a key that may only `PutObject` on
   it (no list, no delete, no read — on MinIO/AWS-style policies:
   `{"Effect":"Allow","Action":["s3:PutObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::<bucket>/*"]}`);
   a lifecycle rule on the bucket for how long bundles stay; then
   `dev-docker/secrets/backup-ship.env` (0600):
   ```
   BACKUP_S3_ENDPOINT=https://<the provider's S3 endpoint>
   BACKUP_S3_BUCKET=<bucket>
   BACKUP_S3_ACCESS_KEY_ID=<write-only key>
   BACKUP_S3_SECRET_ACCESS_KEY=<its secret>
   # optional: BACKUP_S3_PREFIX=txnet/  BACKUP_S3_REGION=…  BACKUP_S3_PROVIDER=…  HTTPS_PROXY=…
   ```
   Then `python3 scripts/bundle/ship.py` once by hand: it sends every bundle waiting.

## Mitigation

### A bundle now

```bash
$BACKUP now          # prints the file, its size, and what it holds
python3 scripts/bundle/ship.py   # optional: send it at once instead of within 10 minutes
```

The timers do the same every night at 03:00 UTC (06:30 Tehran) and every 10
minutes; `$BACKUP install-timers` installs them (done on this server 2026-10-23).

### Prove a bundle comes back — touching nothing

```bash
$BACKUP verify /var/backups/txnet/bundles/<file>
```

Restores it into throwaway containers: every database, row counts against
the manifest, Redis loaded, every archive read. Run it on a bundle you
downloaded from S3, too.

### Bring it up on a new server

1. Docker installed; the repo checked out; `$BACKUP inspect <file> --passphrase-file <p>`
   prints the **commit** it was made at — `git checkout <commit>`.
2. ```bash
   $BACKUP restore <file> --passphrase-file <passphrase file>
   ```
   It writes the keys and env files from the bundle (this checkout has none),
   creates the stack, loads every volume, Redis and database, checks the counts,
   starts everything, publishes the queued messages back, and starts a
   pgBackRest full. The passphrase is copied into place so nightly bundles go on.
3. On prod, the origin firewall (`scripts/edge/cloudflare_firewall.py apply`,
   `install`), then point Cloudflare at the new address:
   `ENV_FILE=.env.prod python3 scripts/edge/edge_zone.py repoint <old> <new>`.
   Allowlists that named the old address: `runbook-move-server.md`, root-cause notes.

### Bring it up on this server (replacing what is here)

```bash
$BACKUP restore <file> --replace
```

A safety bundle of the current state is made first, so a wrong file is undone
with one more `restore --replace <safety bundle>`. Keys and env files this
server has with other content are **kept** and named; the bundle's copies are
in its `keys.tar` if you want them.

## Root-cause notes

- Loss window: up to a day since the last nightly bundle, unless one was made
  with `now`. pgBackRest (runbook-restore-database.md) still reaches to the
  minute on a server that survived.
- A restore into newer code is refused unless `--allow-newer-code`; then apply
  the newer migrations before the services read the schema.
- Queued messages come back with their delay restarted (at most an hour late).
- Not in a bundle: the monitoring history; images (built from the commit).

## Owner

`hosting` (`docs/platform/hosting/`). Built 2026-10-23 (OPS-1-ad). Rehearsed
on dev: `now` (also from the systemd unit), `verify`, `inspect`, a wrong passphrase
and a damaged download (both refused), shipping to MinIO with a write-only key
(it could neither list nor delete), and the download from it checked and
opened. `restore` itself has **not** run yet: its steps are the ones `verify`
proves, against the live stack.
