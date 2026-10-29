#!/usr/bin/env python3
"""The twin run: a release proven on production's data before production (hosting R14,
ADR-0166 points 4, 5, OPS-1-ah-c).

`scripts/staging.sh twin [--from REF] [--to REF]`, with staging up:
1. production's data restored at `--from` (default: the bundle's commit,
   production's running release);
2. `--to` (default HEAD) deployed over it by `prod.k8s.sh deploy` — the
   migration meets production's rows while the old pods still run, as it will;
3. production's panel rows that name its own server's test panels pointed at
   the local copies (/root/paneltest: same panels, same credentials);
4. every check, each run even after one fails: every workload ready, each
   pointed panel collected from by production's drivers, K12's roll under load
   with no failed request, the stores killed and back with their data.

Production's secrets leave this host when it ends, pass or fail; the cluster
stays for its logs until `down`.
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging as ks  # noqa: E402
import k8s_staging_data as kd  # noqa: E402

TO_TREE = "tree-to"
MAIN_DB_POD, MAIN_DB_CONTAINER = "main-db-0", "main-db"
NAMESPACE = "txnet"
# network-service collects each panel once per tick (tens of seconds); a pass
# that has not reached every pointed panel in this long has a broken driver.
PANEL_WAIT_S = 600
PANEL_POLL_S = 10
# Production rolls on a settled node; staging's 35 pods booting at once held the
# dev host at load 9 on 8 cores, and a probe missed there is a 502 (2026-10-29).
QUIET_LOAD_PER_CORE = 0.5
QUIET_WAIT_S = 600
QUIET_POLL_S = 15


@dataclass
class Stages:
    """The run's steps, as functions, so their order is a thing a test can hold."""
    restore: Callable[[str | None], None]
    deploy: Callable[[str], None]
    repoint: Callable[[], None]
    checks: dict[str, Callable[[], bool]] = field(default_factory=dict)


def run(stages: Stages, from_ref: str | None, to_ref: str) -> dict[str, bool]:
    """Restore, deploy over it, point the panels, then every check."""
    stages.restore(from_ref)
    stages.deploy(to_ref)
    stages.repoint()
    return {name: check() for name, check in stages.checks.items()}


def panel_ports(inspect_json: str) -> dict[str, tuple[str, str]]:
    """{published TCP port: (address on staging's network, container port)} of the
    local panels' containers, from `docker inspect`."""
    ports = {}
    for container in json.loads(inspect_json):
        address = container["NetworkSettings"]["Networks"].get(ks.NETWORK, {}).get("IPAddress")
        for inner, bindings in (container["HostConfig"].get("PortBindings") or {}).items():
            port, _, proto = inner.partition("/")
            if address and proto == "tcp":
                ports.update({b["HostPort"]: (address, port) for b in bindings or []})
    return ports


def repoint(url: str, prod_host: str, ports: dict[str, tuple[str, str]]) -> str | None:
    """url moved to its local copy, or None when it names no test panel of
    production's server (a real panel stays unreachable)."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "http" or parts.hostname != prod_host or str(parts.port) not in ports:
        return None
    address, port = ports[str(parts.port)]
    return urllib.parse.urlunsplit(parts._replace(netloc=f"{address}:{port}"))


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def repoint_sql(new_urls: dict[str, str]) -> str:
    return "".join(f'UPDATE network.panel SET "apiBaseUrl" = {sql_text(url)} WHERE id = {sql_text(pid)};\n'
                   for pid, url in new_urls.items())


def psql(sql: str) -> str:
    """sql in main-db as its own user; small statements only (B10: large stdin truncates)."""
    argv = [str(ks.KUBECTL_WRAPPER), "-n", NAMESPACE, "exec", "-i", MAIN_DB_POD, "-c", MAIN_DB_CONTAINER, "--",
            "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1']
    return subprocess.run(argv, input=sql, check=True, text=True, capture_output=True).stdout


def repoint_panels(docker, prod_host: str) -> tuple[list[str], str]:
    """Points the panels; returns their ids and the database's time just before."""
    names = ks.paneltest_containers(docker)
    if not names:
        raise ks.StagingError("no local panel is running: `docker compose -p paneltest up -d` in /root/paneltest")
    ports = panel_ports(docker(["docker", "inspect", *names]).stdout)
    rows = [line.split("|", 1) for line in psql('SELECT id, "apiBaseUrl" FROM network.panel '
                                                'WHERE "retiredAt" IS NULL;').splitlines() if "|" in line]
    moved = {pid: new for pid, url in rows if (new := repoint(url, prod_host, ports))}
    since = psql("SELECT now();").strip()
    if moved:
        psql(repoint_sql(moved))
    print(f"{len(moved)} of {len(rows)} panels pointed at their local copies")
    return list(moved), since


def panels_collected(ids: list[str], since: str) -> bool:
    """Each pointed panel collected from after `since`: production's drivers answered."""
    if not ids:
        print("no panel of production's names a local copy: nothing to collect from")
        return False
    listed = ", ".join(sql_text(i) for i in ids)
    deadline = time.monotonic() + PANEL_WAIT_S
    while True:
        late = psql(f'SELECT name FROM network.panel WHERE id IN ({listed}) AND '
                    f'("lastSuccessfulCollectionAt" IS NULL OR "lastSuccessfulCollectionAt" <= {sql_text(since)});')
        if not late.strip():
            print(f"{len(ids)} panels collected from")
            return True
        if time.monotonic() > deadline:
            print(f"not collected from in {PANEL_WAIT_S}s: {', '.join(late.split())}")
            return False
        time.sleep(PANEL_POLL_S)


def wait_quiet(load: Callable[[], float], cores: int, sleep: Callable[[float], None] = time.sleep,
               wait_s: int = QUIET_WAIT_S) -> bool:
    """True once the 1-minute load is under QUIET_LOAD_PER_CORE a core; False,
    said, when it is not within wait_s — the check then runs on a busy host."""
    waited = 0
    while (now := load()) >= cores * QUIET_LOAD_PER_CORE:
        if waited >= wait_s:
            print(f"load still {now:.1f} on {cores} cores after {wait_s}s: the roll runs on a busy host")
            return False
        step = min(QUIET_POLL_S, wait_s - waited)
        sleep(step)
        waited += step
    return True


def rehearsal_check(docker, name: str) -> bool:
    """One of K12's checks against staging. NODE_EXEC: its crictl and its pids are
    the container's, never this host's (whose k3s is a production agent)."""
    env = {**kd.staging_env(docker), "NODE_EXEC": f"docker exec {ks.CONTAINER}", "CRICTL": "crictl"}
    return subprocess.run(["python3", str(ROOT / "tools" / "k8s_rehearse.py"), name,
                           "--address", env["HOST_GATEWAY"]], env=env).returncode == 0


def deploy_over(docker, ref: str) -> None:
    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", f"{ref}^{{commit}}"],
                            check=True, text=True, capture_output=True).stdout.strip()
    tree = kd.worktree(commit, TO_TREE)
    env = kd.staging_env(docker)
    kd.bring_images(docker, tree, env)
    subprocess.run([f"{tree}/scripts/prod.k8s.sh", "deploy"], env=env, check=True)


def twin(docker, prod: kd.Production, from_ref: str | None, to_ref: str) -> bool:
    pointed: dict = {}

    def do_repoint():
        pointed["ids"], pointed["since"] = repoint_panels(docker, prod.host.rpartition("@")[2])

    def roll():
        wait_quiet(lambda: os.getloadavg()[0], os.cpu_count() or 1)
        return rehearsal_check(docker, "roll")

    checks = {"ready": lambda: rehearsal_check(docker, "ready"),
              "panels": lambda: panels_collected(pointed["ids"], pointed["since"]),
              "roll": roll, "stores": lambda: rehearsal_check(docker, "stores")}
    stages = Stages(restore=lambda ref: kd.restore_production(docker, prod, ref),
                    deploy=lambda ref: deploy_over(docker, ref), repoint=do_repoint, checks=checks)
    try:
        results = run(stages, from_ref, to_ref)
    finally:
        kd.forget(docker)
    for name, ok in results.items():
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    return all(results.values())
