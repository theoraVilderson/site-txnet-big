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

In production these are real `secrets:` entries in `swarm/docker-stack.yml`,
mounted at the same `/run/secrets/<name>` path, so the application code does
not change between the two.

**Losing `vault-kek` makes every stored tenant credential unrecoverable.**
ADR-0026 accepted that; backing it up is an operational requirement, not a
nice-to-have.
