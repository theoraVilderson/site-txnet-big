#!/usr/bin/env python3
"""Staging's one way out, to the dev bots' API only (hosting R18, ADR-0168
point 5, OPS-1-ah-j).

Staging's network stays internal and the egress check unchanged. The way out
is a container of its own, `tools/staging_botgate.py`, on the dev host's bridge
and on staging's network at GATE_ADDRESS. It forwards only the dev bots' sending
calls and refuses the rest.
- `up` starts it, `down` removes it;
- the scrub, while every service is at zero, and the twin after its deploy aim
  each service's env Secret at it: TELEGRAM_API_BASE and BALE_API_BASE to the
  gate, BOT_WEBHOOK_AUTO_REGISTER=false. A service left with production's own
  base fails closed: staging has no route to it;
- the guard refuses a Secret naming a bot API that is not aimed so.
Production's env is deployed whatever the commit, so this is done to the
cluster's Secrets, not to any release's code.
"""
import base64
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging_keys as kk  # noqa: E402
import staging_botgate as gate  # noqa: E402

CONTAINER = "txnet-staging-botgate"
# On staging's TEST-NET-3 subnet (k8s_staging.STAGING_SUBNET), above what IPAM
# hands out to the node and the local panels; taken before any of them joins.
GATE_ADDRESS = "203.0.113.250"
GATE_URL = f"http://{GATE_ADDRESS}:{gate.PORT}"
IMAGE = "python:3.12-alpine"
DEFAULT_UPSTREAMS = {"telegram": "https://api.telegram.org", "bale": "https://tapi.bale.ai"}
AIMED = {"TELEGRAM_API_BASE": f"{GATE_URL}/telegram", "BALE_API_BASE": f"{GATE_URL}/bale",
         "BOT_WEBHOOK_AUTO_REGISTER": "false"}
ROLLOUT_TIMEOUT = "300s"
READY_TRIES, READY_POLL_S = 10, 1


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def run_argv(image: str, root: Path, upstreams: dict[str, str], tokens: dict[str, list[str]]) -> list[str]:
    """The gate on the host's bridge (its route out): only the tokens' hashes go in."""
    env = []
    for platform in gate.PLATFORMS:
        hashes = ",".join(hashlib.sha256(t.encode()).hexdigest() for t in tokens.get(platform, []))
        env += ["-e", f"GATE_UPSTREAM_{platform.upper()}={upstreams[platform]}",
                "-e", f"GATE_TOKENS_{platform.upper()}={hashes}"]
    return ["docker", "run", "-d", "--name", CONTAINER, *env,
            "-v", f"{root}/tools/staging_botgate.py:/gate.py:ro", image, "python", "-u", "/gate.py"]


def start(docker, root: Path, registry: str, network: str) -> None:
    env = kk.dev_env()
    upstreams = {p: env.get(f"{p.upper()}_API_BASE") or base for p, base in DEFAULT_UPSTREAMS.items()}
    tokens = {b.platform: [b.token] for b in kk.dev_bots(env)}
    image = f"{registry}/{IMAGE}"
    if docker(["docker", "image", "inspect", image], check=False).returncode != 0:
        docker(["docker", "pull", "-q", image])
    docker(run_argv(image, root, upstreams, tokens))
    docker(["docker", "network", "connect", "--ip", GATE_ADDRESS, network, CONTAINER])
    print(f"the dev bots' gate is up at {GATE_URL}: {', '.join(tokens) or 'no dev bot, so it refuses everything'}")


def stop(docker) -> None:
    docker(["docker", "rm", "-f", CONTAINER], check=False)


def refuses(docker, node: str, tries: int = READY_TRIES) -> str | None:
    """None when the gate answers from staging's side and refuses a setWebhook.
    Tried a few times: a gate just started is not listening yet."""
    for attempt in range(tries):
        if attempt:
            time.sleep(READY_POLL_S)
        probe = docker(["docker", "exec", node, "wget", "-S", "-q", "-T", "5", "-O", "/dev/null",
                        f"{GATE_URL}/telegram/bot1:probe/setWebhook"], check=False)
        if " 403 " in probe.stderr:
            return None
    return f"the gate at {GATE_URL} did not refuse a setWebhook"


def secret_patch(data: dict) -> dict:
    """The data a service's env Secret gets: only one that names a bot API."""
    return {k: b64(v) for k, v in AIMED.items()} if set(data) & set(AIMED) else {}


def _get(kubectl: list[str], *args) -> dict:
    return json.loads(subprocess.run([*kubectl, "get", *args, "-o", "json"], check=True, text=True,
                                     capture_output=True).stdout)


def service_secrets(kubectl: list[str]) -> dict[str, tuple[list[str], dict]]:
    """{Secret: (the Deployments that load it as env, its data)}."""
    users: dict[str, list[str]] = {}
    for d in _get(kubectl, "deployment")["items"]:
        for c in d["spec"]["template"]["spec"]["containers"]:
            for ref in c.get("envFrom") or []:
                if "secretRef" in ref:
                    users.setdefault(ref["secretRef"]["name"], []).append(d["metadata"]["name"])
    return {name: (deployments, _get(kubectl, "secret", name).get("data") or {})
            for name, deployments in users.items()}


def aim(kubectl: list[str], restart: bool = False) -> list[str]:
    """Each service Secret naming a bot API aimed at the gate; returns the
    Deployments using one. `restart`: they are running, and read env at start."""
    touched = []
    for name, (deployments, data) in service_secrets(kubectl).items():
        patch = secret_patch(data)
        if patch and any(data.get(k) != v for k, v in patch.items()):
            subprocess.run([*kubectl, "patch", "secret", name, "--type", "merge", "-p",
                            json.dumps({"data": patch})], check=True, capture_output=True)
            touched += deployments
    for deployment in sorted(set(touched)) if restart else []:
        subprocess.run([*kubectl, "rollout", "restart", f"deployment/{deployment}"], check=True, capture_output=True)
        subprocess.run([*kubectl, "rollout", "status", f"deployment/{deployment}", f"--timeout={ROLLOUT_TIMEOUT}"],
                       check=True, capture_output=True)
    print(f"bots: {len(set(touched))} service(s) aimed at the gate, webhook registration off")
    return sorted(set(touched))


def findings(secrets: dict[str, dict]) -> list[str]:
    found = []
    for name, data in sorted(secrets.items()):
        if not set(data) & set(AIMED):
            continue
        found += [f"secret {name}: {key} is not {value!r}" for key, value in AIMED.items()
                  if base64.b64decode(data.get(key, "")).decode() != value]
    return found


def guard(kubectl: list[str]) -> list[str]:
    return findings({name: data for name, (_, data) in service_secrets(kubectl).items()})
