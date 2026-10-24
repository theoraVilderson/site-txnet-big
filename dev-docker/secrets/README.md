# Dev secrets

Files the dev stack mounts into a container as if they were Docker Swarm
secrets, so nothing in this repo has to read a secret from an environment
variable (ADR-0026).

**Every file here except this one is ignored by git, and that is the point.**
A key that lives in the repo is not a secret. Generate your own:

```bash
openssl rand -base64 32 > dev-docker/secrets/vault-kek
```

| file | used by | what it is |
|---|---|---|
| `vault-kek` | `auth-service` (`VAULT_KEK_FILE`) | the Credential Vault's key-encryption key — 32 bytes, base64 or hex |
| `object-backup-password` | `object-backup` (`RESTIC_PASSWORD_FILE`, F-414-m) | the restic repository's password: `openssl rand -base64 32 > dev-docker/secrets/object-backup-password` |
| `pg-backup-passphrase` | `main-db`, `pg-backup` (OPS-1-a, hosting H2) | pgBackRest's repository cipher passphrase: `openssl rand -base64 48 > dev-docker/secrets/pg-backup-passphrase` |
| `backup-bundle-passphrase` | `scripts/bundle/` (OPS-1-ad, hosting B5) | opens every backup bundle: `openssl rand -base64 48 > dev-docker/secrets/backup-bundle-passphrase`; **a copy off the server** — never inside a bundle |
| `backup-ship.env` | `scripts/bundle/ship.py` (OPS-1-ad, B7) | the write-only S3 key and bucket bundles are sent with; absent, nothing is sent (`runbook-backup-bundle.md`) |
| `origin-pull/` | nothing at runtime — `scripts/edge/origin-pull.sh` (EDGE-1-g) | our origin-pull CA's key and the client pair Cloudflare holds; `ca.pem` sits in `traefik/origin-pull/`. Lost: run `issue` with `FORCE=1`, then `upload` |

`scripts/prod.compose.sh` makes this directory 0700 and each file a compose
service binds 0644: a bind keeps the host's mode, and the prod images run as
`node`, not root (OPS-1-o-v). Only root on the host reads them still.

In production on Kubernetes each bound file is a Secret mounted at the same
`/run/secrets/<name>` path (hosting K7), so the application code does not
change between the two. There the files are committed encrypted under
`k8s/sealed/` and never read from here (`contract.secrets.md`, OPS-1-o-j) —
except `backup-bundle-passphrase`, which is never sealed.

**Losing `vault-kek` makes every stored tenant credential unrecoverable.**
ADR-0026 accepted that; backing it up is an operational requirement, not a
nice-to-have.

**Losing `object-backup-password` makes every object-storage snapshot
unreadable** (ADR-0120): keep it wherever `vault-kek` is kept.

**Losing `pg-backup-passphrase` makes every database backup and archived WAL
segment unreadable** (ADR-0126): the same rule.
