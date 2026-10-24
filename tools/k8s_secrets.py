#!/usr/bin/env python3
"""Secrets on Kubernetes: the files the render reads as secret, committed
SOPS-encrypted to the node's age key (ADR-0164 point 7, hosting K5,
contract.secrets.md).

    python3 tools/k8s_secrets.py init            the node's age key and .sops.yaml, once per platform
    python3 tools/k8s_secrets.py list            what is sealed, and whether each copy exists
    python3 tools/k8s_secrets.py seal [path...]  encrypt what is not sealed yet; a named path is replaced
    python3 tools/k8s_secrets.py open <dir>      decrypt every sealed file into <dir> (prod.k8s.sh render)
    python3 tools/k8s_secrets.py edit <path>     `sops edit` its sealed copy; then `prod.k8s.sh deploy`

What is sealed is derived: each stack's env files, and each secret file a
service mounts (k8srender/sealed.py), plus the origin-pull client pair the
smoke check presents (K16). SOPS_AGE_KEY_FILE overrides the key's
place; sops and age-keygen come from `prod.k8s.sh install-tools`.
"""
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# K5: on the node, outside the checkout, so no clean or re-clone loses it and
# no seal can reach it. The bundle carries it (B5); a copy sits off the
# server beside the bundle's passphrase.
AGE_KEY_FILE = "/etc/txnet/age.key"
SOPS_CONFIG = ".sops.yaml"
# The creation rule `sops` applies to a new file under k8s/sealed/ by hand too.
_SOPS_RULES = """# The recipient every sealed file is encrypted to (hosting K5, contract.secrets.md).
# Written by `tools/k8s_secrets.py init` on the node; the private key is {key}.
creation_rules:
  - path_regex: (^|/)k8s/sealed/.*\\.sops$
    age: {recipient}
"""


class SecretsError(Exception):
    """A seal or an open that would leave the secrets wrong; the message says which."""


def key_env(env=None) -> dict:
    """The environment sops runs in: the node's key unless SOPS_AGE_KEY_FILE names another."""
    env = dict(env or os.environ)
    env.setdefault("SOPS_AGE_KEY_FILE", AGE_KEY_FILE)
    return env


def init(root: Path, key: Path) -> str:
    """Makes the age key (0600) and .sops.yaml naming its recipient; returns the
    recipient. Never a second key: every sealed file opens with the first one."""
    if key.exists() or (root / SOPS_CONFIG).exists():
        raise SecretsError(f"{key} or {SOPS_CONFIG} exists: restore the key from the bundle, never make a second")
    key.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    subprocess.run(["age-keygen", "-o", str(key)], check=True, capture_output=True)
    key.chmod(0o600)
    recipient = subprocess.run(["age-keygen", "-y", str(key)], check=True, capture_output=True,
                               text=True).stdout.strip()
    (root / SOPS_CONFIG).write_text(_SOPS_RULES.format(key=key, recipient=recipient))
    return recipient


def seal(root: Path, paths: list[str], env=None, replace: bool = True) -> list[str]:
    """Encrypts each plaintext path into its sealed copy; returns those written.
    With replace False an existing copy is kept: after `sops edit` the
    plaintext on disk is stale, and writing it back would undo the rotation.
    An unchanged file is left alone: a new ciphertext of the same bytes is a
    diff nobody can review."""
    from k8srender.sealed import sealed_path
    written = []
    for rel in paths:
        source, target = root / rel, root / sealed_path(rel)
        if target.exists() and not replace:
            continue
        if not source.is_file():
            raise SecretsError(f"{rel}: no plaintext to seal")
        if target.exists() and _decrypt(target, env) == source.read_bytes():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        sealed = subprocess.run(["sops", "encrypt", "--filename-override", sealed_path(rel), str(source)],
                                check=True, capture_output=True, cwd=root, env=key_env(env)).stdout
        partial = target.with_name(target.name + ".partial")
        partial.write_bytes(sealed)
        partial.replace(target)
        written.append(rel)
    return written


def open_files(root: Path, paths: list[str], out: Path, env=None) -> None:
    """Decrypts each path's sealed copy to out/<path>, owner-only."""
    from k8srender.sealed import sealed_path
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    for rel in paths:
        sealed = root / sealed_path(rel)
        if not sealed.is_file():
            raise SecretsError(f"{rel} is not sealed: `scripts/prod.k8s.sh secrets seal {rel}`")
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(os.open(target, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), "wb") as f:
            f.write(_decrypt(sealed, env))


def _decrypt(sealed: Path, env) -> bytes:
    return subprocess.run(["sops", "decrypt", str(sealed)], check=True, capture_output=True,
                          env=key_env(env)).stdout


def env_files() -> list[str]:
    """Every stack's env files, each once (K2, K11)."""
    from k8srender.tables import STACKS
    return list(dict.fromkeys(f for stack in STACKS.values() for f in stack.env_files))


def secret_paths(env_dir: Path | None = None) -> list[str]:
    """The secret files every stack's render reads, from models interpolated with
    the env files under env_dir (opened ones) or in the checkout."""
    import k8s_render
    from k8srender.sealed import secret_files
    from k8srender.tables import STACKS
    found = set()
    for stack in STACKS.values():
        files = [str(env_dir / f) if env_dir else f for f in stack.env_files]
        found.update(secret_files(k8s_render.load_model(stack, files, {}), REPO))
    return sorted(found)


def main(argv: list[str]) -> int:
    from k8srender.sealed import sealed_path, smoke_files
    cmd, args = (argv[1], argv[2:]) if len(argv) > 1 else ("", [])
    if cmd == "init":
        recipient = init(REPO, Path(key_env()["SOPS_AGE_KEY_FILE"]))
        print(f"age recipient {recipient}; copy {key_env()['SOPS_AGE_KEY_FILE']} off the server now (K5)")
    elif cmd == "list":
        for rel in env_files() + secret_paths() + smoke_files():
            print(f"{'sealed ' if (REPO / sealed_path(rel)).is_file() else 'MISSING'}  {rel}")
    elif cmd == "seal":
        written = seal(REPO, args or env_files() + secret_paths() + smoke_files(), replace=bool(args))
        print(f"sealed {len(written)}: {', '.join(written) or 'nothing changed'}")
    elif cmd == "open" and len(args) == 1:
        out = Path(args[0])
        open_files(REPO, env_files(), out)
        open_files(REPO, secret_paths(out) + smoke_files(), out)
    elif cmd == "edit" and len(args) == 1:
        os.execvpe("sops", ["sops", "edit", str(REPO / sealed_path(args[0]))], key_env())
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (SecretsError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", None)
        print(f"k8s_secrets: {error}{': ' + detail.decode().strip() if detail else ''}", file=sys.stderr)
        sys.exit(1)
