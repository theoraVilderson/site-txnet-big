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
| `origin-pull/` | nothing at runtime — `scripts/edge/origin-pull.sh` (EDGE-1-g) | our origin-pull CA's key and the client pair Cloudflare holds; `ca.pem` sits in `traefik/origin-pull/`. Lost: run `issue` with `FORCE=1`, then `upload` |

In production these are real `secrets:` entries in `swarm/docker-stack.yml`,
mounted at the same `/run/secrets/<name>` path, so the application code does
not change between the two.

**Losing `vault-kek` makes every stored tenant credential unrecoverable.**
ADR-0026 accepted that; backing it up is an operational requirement, not a
nice-to-have.

**Losing `object-backup-password` makes every object-storage snapshot
unreadable** (ADR-0120): keep it wherever `vault-kek` is kept.

**Losing `pg-backup-passphrase` makes every database backup and archived WAL
segment unreadable** (ADR-0126): the same rule.
