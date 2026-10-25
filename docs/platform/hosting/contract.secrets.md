---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: secrets on Kubernetes

The build spec for K5's values (ADR-0164 points 6–7, OPS-1-o-j). Decided by
the user on 2026-10-24: SOPS files encrypted to an age key, committed in the
repo; k3s's `--secrets-encryption`; the real key made on the test server with
the user. Every value here is decided; a building session does not reopen one.

## TL;DR
What the render reads as secret is committed encrypted under `k8s/sealed/`.
`prod.k8s.sh render` opens it into `/dev/shm` for the length of the render and
renders from there; the checkout's plaintext is never read. Rotation is
`prod.k8s.sh secrets edit <path>`, then `deploy`.

## Rules

**S1 — What is sealed is derived, not listed.** Every stack's env files
(`tables.py` STACKS: `.env`, `.env.prod`, `dev-docker/monitoring/.env.prod`),
each file under `dev-docker/secrets/` a compose service binds (K7), and each
compose `secrets:` file a service mounts (K11) — `k8srender/sealed.py`
`secret_files`. A key file bound tomorrow is sealed with no edit here. What a
tool reads and no service mounts is named instead (`tool_files`): the origin-pull
`client.pem`/`client.key`, which the smoke check presents (R6), never `ca.key`;
the Arvan API key `edge_zone.py arvan` writes with (O14), which a tool opens in
memory with `k8s_secrets.opened`.
`dev-docker/secrets/backup-bundle-passphrase` is never sealed, and a service
mounting it fails the render: the age key rides in the bundle (S3), so the
passphrase in the repo would let a bundle open itself (B5).

**S2 — One sealed file per secret file.** `k8s/sealed/<path>.sops`, a leading
dot spelt `dot` (`.env.prod` -> `dotenv.prod.sops`: `.env*` is git-ignored).
Each is sops's binary format, so it opens byte for byte; sops's dotenv parser
refused a comment in `.env` and rewrote 15 lines of `.env.prod`. `.sops.yaml`
names the recipient for every new file under `k8s/sealed/`.

**S3 — One age key, outside the checkout.** `/etc/txnet/age.key`, 0600
(`tools/k8s_secrets.py` AGE_KEY_FILE; `SOPS_AGE_KEY_FILE` overrides it for a
test). `secrets init` makes it once and writes `.sops.yaml`; it refuses when
either exists, since a second key would orphan every sealed file — a new node
restores the key from the bundle instead. The bundle carries it at its
absolute path (`bundle_plan.key_tar_args`, B5); a copy is kept off the server
beside the bundle's passphrase.

**S4 — Opened only in memory, only for the render.** `prod.k8s.sh render`
makes a `mktemp -d /dev/shm/txnet-secrets.*`, runs `k8s_secrets.py open` into
it (env files first, then the secret files their models name), renders both
stacks with `k8s_render.py --sealed`, and removes it; an exit trap removes it
on failure too. Under `--sealed` a secret file missing from the opened copies
fails the render ("… is not sealed"), never falls back to the checkout.

**S5 — Rotation.** `prod.k8s.sh secrets edit <path>` (`sops edit` of its sealed
copy), commit, `deploy`: the Secret's hashed name changes (K5) and every pod
that mounts it rolls. A bare `secrets seal` adds only the copies that do not
exist yet, so the stale plaintext left on disk cannot undo a rotation;
`secrets seal <path>` replaces that one. An unchanged file is not re-encrypted.

**S6 — At rest in the cluster.** `k8s/k3s/config.yaml` is the server's flags
(K1) and sets `secrets-encryption: true`; OPS-1-o-f copies it to
`/etc/rancher/k3s/config.yaml` before installing k3s.

**S7 — The tools.** `prod.k8s.sh install-tools` puts `sops` and `age-keygen` at
`k8s/versions.env`'s pins into `/usr/local/bin`, each checked against its
sha256. Nothing else needs them: sops embeds age.

**S8 — What the render needs is there** (OPS-1-o-u, -w). Before compose reads
the model, `k8s_render.py` names a missing env file with the variables only it
would set (no default, no other file sets them) rather than compose's traceback;
then it refuses a `*DB_*PASSWORD` the stack names that the env files leave blank,
which compose would hand every service as an empty password (P1000 at boot).
`dev-docker/monitoring/.env.prod` holds only what `.env`/`.env.prod` leave unset
(ports, Grafana's host and login); the move carries it (`move_plan.py`).

## The first seal (OPS-1-o-f, with the user)

On the test server: `install-tools`, `secrets init`, copy the key off the
server, `secrets seal`, `secrets list` (every line `sealed`), commit
`.sops.yaml` and `k8s/sealed/`. The dev host never holds the production key.

## Proof

2026-10-24, with a throwaway key on the dev host: the seven files S1 derives
sealed, none of 38 values of 8+ characters in any of them; `prod.k8s.sh render`
from them byte-identical to the plaintext render for both stacks, nothing left
in `/dev/shm`; a `secrets edit` of `vault-kek` reached its Secret under a new
name in four pods with the plaintext untouched, and a bare `seal` kept it;
`install-tools` verified both pins. In a throwaway k3s started from
`k8s/k3s/config.yaml`: `secrets-encrypt status` Enabled, a Secret's value
absent from the raw datastore (`k8s:enc:aescbc:v1`) while a ConfigMap's was
there in the clear. Tests: `tools/k8s_secrets_test.py`.
