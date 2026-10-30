#!/usr/bin/env python3
"""The production twin's cluster on the dev host (hosting R14, ADR-0166, OPS-1-ah-a).

    python3 tools/k8s_staging.py up        the dev stack paused, k3s at k8s/versions.env's pin in one
                                           container on an --internal network with the local panels,
                                           production's server flags, egress proven closed, the dev bots'
                                           gate its one way out (tools/k8s_staging_gate.py, OPS-1-ah-j)
    python3 tools/k8s_staging.py import IMAGE...
                                           images from this host's Docker into the cluster: it pulls nothing
    python3 tools/k8s_staging.py restore [--at REF]
                                           production's newest bundle into it, at the bundle's commit
                                           (tools/k8s_staging_data.py, OPS-1-ah-b)
    python3 tools/k8s_staging.py twin [--from REF] [--to REF]
                                           the twin run: production's data at --from, --to (HEAD) deployed
                                           over it, every check (tools/k8s_staging_twin.py, OPS-1-ah-c)
    python3 tools/k8s_staging.py open [--port 8443]
                                           the owner's browser in staging, through ssh and a proxy
                                           presenting the origin-pull pair (tools/k8s_staging_open.py, OPS-1-ah-i)
    python3 tools/k8s_staging.py status    the container, the node, the egress check
    python3 tools/k8s_staging.py down      container, volume and network removed; the image store kept once
                                           proven to hold only images (tools/k8s_staging_images.py,
                                           OPS-1-ah-e); the dev stack started again if `up` stopped it

Run as root on the dev host, from the checkout (`scripts/staging.sh`). The
cluster holds production's data in OPS-1-ah-b, so `up` refuses to leave it
standing with a route out, and `down` leaves nothing of it behind but images.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "scripts" / "bundle"))
from bundle_plan import parse_env  # noqa: E402
from k8s_memfit import K3S_BASE_MIB, K3S_PER_POD_MIB, repo_workloads  # noqa: E402
import k8s_staging_gate as kg  # noqa: E402
import k8s_staging_images as ki  # noqa: E402

CONTAINER = NETWORK = "txnet-staging"
# TEST-NET-3 (RFC 5737): routed nowhere, and not private, so network-service's
# egress guard (ADR-0095) lets production's drivers reach the local panels on it
# — at 172.24.0.x it refused them, rightly, as a reseller's panel.
STAGING_SUBNET = "203.0.113.0/24"
VOLUME = "txnet-staging-k3s"
STATE_FILE = Path("/var/lib/txnet/staging.json")
CACHE_DIR = Path("/var/cache/txnet-staging")
# Where the kubeconfig is written: it is the throwaway cluster's admin login.
KUBECONFIG = CACHE_DIR / "kubeconfig.yaml"
# prod.k8s.sh and backup.py run "$KUBECTL" as one program: this one aims at staging.
KUBECTL_WRAPPER = CACHE_DIR / "kubectl"
# k3s's system images (pause, coredns, local-path, klipper-lb, metrics-server):
# the node cannot pull them, so the release's air-gap archive is mounted where
# k3s imports from at start.
AIRGAP_FILE = "k3s-airgap-images-amd64.tar.zst"
AIRGAP_DIR = "/var/lib/rancher/k3s/agent/images"
RELEASE_URL = "https://github.com/k3s-io/k3s/releases/download/{tag}/{name}"
SUMS_FILE = "sha256sum-amd64.txt"
PANELTEST_PROJECT = "paneltest"
# ADR-0166 point 2: an address that answers from anywhere with a route out.
EGRESS_PROBE_URL = "http://1.1.1.1"
EGRESS_PROBE_TIMEOUT_S = 5
NODE_READY_TIMEOUT_S = 300
NODE_POLL_S = 3
# ctr's namespace the kubelet reads images from.
CTR_NAMESPACE = "k8s.io"
FAILED_LOG_LINES = 40
# The line staging's kubelet evicts at, and `up` keeps clear of. Crossed, it
# evicts pods and deletes images whatever the GC thresholds say, and staging
# cannot pull them back. 5%, not the kubelet's 15%: a node policy, not the
# release's, and the dev host's disk cannot spare 15% beside staging's peak.
EVICTION_FREE_FRACTION = 0.05
# What staging adds to the disk at its peak: a release's 36 images plus its pods,
# measured 2026-10-29: 33 GiB free fell to 18 during a twin run (15), plus 2.
STAGING_PEAK_GIB = 17
GIB = 1 << 30
# k3s exits "no default routes found" without one, and an internal network has
# none: a route on the container's own link, with no gateway behind it. Nothing
# answers there, which egress_problem proves on every `up`.
SERVER_COMMAND = ("ip route add default dev eth0 && exec /bin/k3s server"
                  # A node with no route out cannot pull an image back: its kubelet never
                  # deletes one. At 88% disk it deleted 18 of 36 before their pods started.
                  " --kubelet-arg=image-gc-high-threshold=100 --kubelet-arg=image-gc-low-threshold=99"
                  # quoted: sh reads an unquoted `<` as a redirect
                  " '--kubelet-arg=eviction-hard=imagefs.available<{0:.0%},nodefs.available<{0:.0%}'"
                  .format(EVICTION_FREE_FRACTION))


class StagingError(Exception):
    """A reason staging cannot be brought up or trusted, said to the operator."""


def docker_run(argv, check=True, **kwargs):
    """subprocess.run with text output: the one way this module calls a program."""
    return subprocess.run(argv, check=check, text=True, capture_output=True, **kwargs)


def k3s_image(registry: str, version: str) -> str:
    """The rancher/k3s image of K3S_VERSION through the mirror: `+` is not a tag character."""
    return f"{registry}/rancher/k3s:{version.replace('+', '-')}"


def airgap_sha256(sums: str) -> str:
    """The air-gap archive's sha256 from the release's own sum list."""
    for line in sums.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == AIRGAP_FILE:
            return parts[0]
    raise StagingError(f"the release lists no {AIRGAP_FILE}")


def run_argv(image: str, root: Path, airgap: Path) -> list[str]:
    """`docker run` for the server: privileged (it runs containerd and iptables), on
    the internal network only, publishing nothing, production's config (K1)."""
    return ["docker", "run", "-d", "--name", CONTAINER, "--hostname", CONTAINER, "--privileged",
            f"--network={NETWORK}", "--tmpfs", "/run", "--tmpfs", "/var/run",
            "-v", f"{VOLUME}:/var/lib/rancher/k3s", *ki.mount_args(),
            "-v", f"{root}/k8s/k3s/config.yaml:/etc/rancher/k3s/config.yaml:ro",
            "-v", f"{airgap}:{AIRGAP_DIR}/{AIRGAP_FILE}:ro",
            "--entrypoint", "/bin/sh", image, "-c", SERVER_COMMAND]


def egress_problem(docker) -> str | None:
    """None when nothing leaves: the network is internal and the probe gets no answer."""
    inspected = json.loads(docker(["docker", "network", "inspect", NETWORK]).stdout)
    if not inspected or not inspected[0].get("Internal"):
        return f"network {NETWORK} is not internal: it has a route out"
    probe = docker(["docker", "exec", CONTAINER, "wget", "-q", "-T", str(EGRESS_PROBE_TIMEOUT_S),
                    "-O", "/dev/null", EGRESS_PROBE_URL], check=False)
    if probe.returncode == 0:
        return f"{EGRESS_PROBE_URL} answered from inside {CONTAINER}"
    return None


def fit_problem(workloads, available_mib: float) -> str | None:
    """K19's requests plus k3s against the memory free now (the host's own use is
    already out of MemAvailable, so K19's HOST_BASE_MIB is not added)."""
    need = sum(w.request or 0 for w in workloads) + K3S_BASE_MIB + K3S_PER_POD_MIB * sum(w.pod for w in workloads)
    if need > available_mib:
        return f"staging needs {need:.0f} MiB and {available_mib:.0f} MiB is free"
    return None


def disk_problem(total: int, free: int, held: int = 0) -> str | None:
    """None when staging's peak fits above the kubelet's eviction line; `held` is the
    kept image store (OPS-1-ah-e), already on the disk and part of that peak."""
    need = total * EVICTION_FREE_FRACTION + STAGING_PEAK_GIB * GIB - held
    if free < need:
        return (f"staging needs {need / GIB:.0f} GiB free on / and {free / GIB:.0f} GiB is: "
                "free room first (docker builder prune, old registry tags — never `docker volume prune`)")
    return None


def room_problem(docker) -> str | None:
    """disk_problem for / now, the kept image store counted as part of the peak."""
    disk = os.statvfs("/")
    return disk_problem(disk.f_blocks * disk.f_frsize, disk.f_bavail * disk.f_frsize, ki.held_bytes(docker))


def write_state(path: Path, dev_stack_was_running: bool) -> None:
    """What `up` changed on the host, for `down` to put back."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"devStackWasRunning": dev_stack_was_running}))


def remove(docker, root: Path, state: Path) -> None:
    """Everything `up` made, gone, and the dev stack back if `up` stopped it. Safe
    to run on a half-made staging: each step tolerates what is already absent."""
    # The drain needs the node's containerd running, the compaction needs it stopped.
    kept = ki.keep(docker, CONTAINER)
    # -v: the k3s image declares /var/log and /var/lib/kubelet as volumes; without it
    # every run's pod logs outlived `down`.
    docker(["docker", "rm", "-f", "-v", CONTAINER], check=False)
    if kept:
        ki.seal(docker)
    kg.stop(docker)
    docker(["docker", "volume", "rm", VOLUME], check=False)
    for name in paneltest_containers(docker):
        docker(["docker", "network", "disconnect", "-f", NETWORK, name], check=False)
    docker(["docker", "network", "rm", NETWORK], check=False)
    # Late: k8s_staging_data imports this module.
    import k8s_staging_data
    k8s_staging_data.forget(docker)
    if state.exists():
        if json.loads(state.read_text()).get("devStackWasRunning"):
            docker([f"{root}/scripts/dev.compose.sh", "start"])
        state.unlink()
    KUBECONFIG.unlink(missing_ok=True)
    KUBECTL_WRAPPER.unlink(missing_ok=True)


def create_network(docker) -> None:
    docker(["docker", "network", "create", "--internal", f"--subnet={STAGING_SUBNET}", NETWORK])


def paneltest_containers(docker) -> list[str]:
    """The local panels' containers that own a network namespace: one living in
    another's (`network_mode: service:…`) cannot be connected, and needs not be."""
    out = docker(["docker", "ps", "--filter", f"label=com.docker.compose.project={PANELTEST_PROJECT}",
                  "--format", "{{.Names}} {{.Networks}}"], check=False).stdout
    return [parts[0] for parts in (line.split() for line in out.splitlines()) if len(parts) == 2]


def dev_stack_running(docker) -> bool:
    out = docker(["docker", "ps", "-q", "--filter", "label=com.docker.compose.project=devtxnet"]).stdout
    return bool(out.strip())


def mem_available_mib() -> float:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 1024
    raise StagingError("/proc/meminfo has no MemAvailable")


def fetch_airgap(version: str) -> Path:
    """The release's air-gap archive, downloaded once per K3S_VERSION and checked
    against the release's sum list every time it is used."""
    tag = urllib.parse.quote(version, safe="")
    target = CACHE_DIR / version / AIRGAP_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    sums = subprocess.run(["curl", "-fsSL", RELEASE_URL.format(tag=tag, name=SUMS_FILE)],
                          check=True, text=True, capture_output=True).stdout
    expected = airgap_sha256(sums)
    if not target.exists():
        subprocess.run(["curl", "-fsSL", "-o", str(target), RELEASE_URL.format(tag=tag, name=AIRGAP_FILE)], check=True)
    actual = subprocess.run(["sha256sum", str(target)], check=True, text=True, capture_output=True).stdout.split()[0]
    if actual != expected:
        target.unlink()
        raise StagingError(f"{AIRGAP_FILE} does not match the release's sum: removed, run `up` again")
    return target


def wait_ready(docker) -> None:
    deadline = time.monotonic() + NODE_READY_TIMEOUT_S
    while time.monotonic() < deadline:
        nodes = docker(["docker", "exec", CONTAINER, "kubectl", "get", "nodes", "--no-headers"], check=False).stdout
        if nodes and all(" Ready " in f" {line} " for line in nodes.splitlines()):
            return
        time.sleep(NODE_POLL_S)
    raise StagingError(f"the node was not Ready in {NODE_READY_TIMEOUT_S}s: docker logs {CONTAINER}")


def container_address(docker) -> str:
    """The container's address on the network: its API, and Traefik's 80/443 (svclb)."""
    return docker(["docker", "inspect", "-f", f'{{{{(index .NetworkSettings.Networks "{NETWORK}").IPAddress}}}}',
                   CONTAINER]).stdout.strip()


def write_kubeconfig(docker) -> None:
    """The cluster's kubeconfig, its server the container's address, and KUBECTL_WRAPPER
    using it with no proxy (the host's proxy answers a private address with EOF)."""
    config = docker(["docker", "exec", CONTAINER, "cat", "/etc/rancher/k3s/k3s.yaml"]).stdout
    KUBECONFIG.write_text(config.replace("https://127.0.0.1:6443", f"https://{container_address(docker)}:6443"))
    KUBECONFIG.chmod(0o600)
    KUBECTL_WRAPPER.write_text("#!/bin/sh\nexport NO_PROXY='*' no_proxy='*'\n"
                               f'exec k3s kubectl --kubeconfig {KUBECONFIG} "$@"\n')
    KUBECTL_WRAPPER.chmod(0o700)


def up(docker, root: Path, state: Path) -> None:
    if docker(["docker", "inspect", CONTAINER], check=False).returncode == 0:
        raise StagingError(f"{CONTAINER} exists: `down` first")
    problem = room_problem(docker)
    if problem:
        raise StagingError(problem)
    versions = parse_env((root / "k8s" / "versions.env").read_text())
    registry = parse_env((root / ".env").read_text())["DOCKER_REGISTRY"]
    image = k3s_image(registry, versions["K3S_VERSION"])
    airgap = fetch_airgap(versions["K3S_VERSION"])
    docker(["docker", "pull", "-q", image])
    # ADR-0166 point 6: the dev stack gives its memory back for the run.
    was_running = dev_stack_running(docker)
    write_state(state, dev_stack_was_running=was_running)
    try:
        if was_running:
            docker([f"{root}/scripts/dev.compose.sh", "stop"])
        problem = fit_problem(repo_workloads(), mem_available_mib())
        if problem:
            raise StagingError(problem)
        create_network(docker)
        kg.start(docker, root, registry, NETWORK)  # first: its address is fixed
        for name in paneltest_containers(docker):
            docker(["docker", "network", "connect", NETWORK, name])
        docker(run_argv(image, root, airgap))
        wait_ready(docker)
        problem = egress_problem(docker) or kg.refuses(docker, CONTAINER)
        if problem:
            raise StagingError(f"{problem}: staging removed, nothing was restored into it")
        write_kubeconfig(docker)
    except (StagingError, subprocess.CalledProcessError):
        # The container goes with `remove`, and its log with it: shown first.
        logs = docker(["docker", "logs", "--tail", str(FAILED_LOG_LINES), CONTAINER], check=False)
        print(logs.stdout + logs.stderr, file=sys.stderr)
        remove(docker, root, state)
        raise
    print(f"staging is up. KUBECTL={KUBECTL_WRAPPER}")


def not_held(docker, images: list[str]) -> list[str]:
    """The images staging does not hold yet: a second deploy names mostly the same ones."""
    held = set(docker(["docker", "exec", CONTAINER, "ctr", "-n", CTR_NAMESPACE, "images", "ls", "-q"]).stdout.split())
    return [image for image in images if image not in held]


def import_images(docker, images: list[str]) -> None:
    """`docker save | ctr import`, one image at a time, each one staging lacks:
    nothing is pulled by the node (K14)."""
    for image in not_held(docker, images):
        save = subprocess.Popen(["docker", "save", image], stdout=subprocess.PIPE)
        subprocess.run(["docker", "exec", "-i", CONTAINER, "ctr", "-n", CTR_NAMESPACE, "images", "import", "-"],
                       stdin=save.stdout, check=True, capture_output=True)
        if save.wait() != 0:
            raise StagingError(f"docker save {image} failed")
        print(f"imported {image}")


def status(docker) -> int:
    if docker(["docker", "inspect", CONTAINER], check=False).returncode != 0:
        print(f"{CONTAINER}: not running")
        return 1
    print(docker(["docker", "exec", CONTAINER, "kubectl", "get", "nodes"], check=False).stdout.rstrip())
    problem = egress_problem(docker)
    problem = problem or kg.refuses(docker, CONTAINER)
    print(f"egress: {problem or 'closed, but for the dev bots gate'}")
    return 1 if problem else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["up", "import", "restore", "twin", "open", "status", "down"])
    parser.add_argument("images", nargs="*")
    parser.add_argument("--at", "--from", dest="at", help="restore, twin: production's data at this "
                        "commit, not the bundle's")
    parser.add_argument("--to", default="HEAD", help="twin: the release deployed over it")
    parser.add_argument("--port", type=int, default=8443, help="open: the proxy's port on this host's loopback")
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print("k8s_staging.py: run as root on the dev host", file=sys.stderr)
        return 1
    try:
        if args.command == "up":
            up(docker_run, ROOT, STATE_FILE)
        elif args.command == "import":
            import_images(docker_run, args.images)
        elif args.command in ("restore", "twin"):
            import k8s_staging_data as kd  # late: both import this module
            import k8s_staging_twin as kt
            prod = kd.Production.from_env({**parse_env((ROOT / ".env.dev").read_text()), **os.environ})
            if args.command == "restore":
                kd.restore_production(docker_run, prod, args.at)
            elif not kt.twin(docker_run, prod, args.at, args.to):
                return 1
        elif args.command == "open":
            import k8s_staging_open as ko  # late: it imports this module
            ko.open_staging(docker_run, args.port)
        elif args.command == "status":
            return status(docker_run)
        else:
            remove(docker_run, ROOT, STATE_FILE)
    except StagingError as e:
        print(f"k8s_staging.py: {e}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as e:
        print(f"k8s_staging.py: {' '.join(e.cmd)} failed: {(e.stderr or '').strip()}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
