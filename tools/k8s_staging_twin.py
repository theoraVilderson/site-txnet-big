#!/usr/bin/env python3
"""The twin run: a release proven on production's data before production (hosting R14,
ADR-0166 points 4, 5, OPS-1-ah-c).

`scripts/staging.sh twin [--from REF] [--to REF]`, with staging up:
1. production's data restored at `--from` (default: the bundle's commit,
   production's running release);
2. `--to` (default HEAD) deployed over it by `prod.k8s.sh deploy` — the
   migration meets production's rows while the old pods still run, as it will;
3. the scrub's guard again (ADR-0168): the restore pointed production's test
   panels at their local copies and wiped every other one before any service
   started (`k8s_staging_scrub.py`); the new release's migration must not have
   brought a real address back;
4. the checks asked (`--checks`, default all; `ready` always: ADR-0169), each run
   even after one fails: every workload ready, each pointed panel collected from
   by production's drivers, K12's roll under load with no failed request, the
   stores killed and back with their data.

Production's secrets leave this host when it ends, pass or fail; the cluster
stays for its logs until `down`.
"""
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging as ks  # noqa: E402
import k8s_staging_data as kd  # noqa: E402
import k8s_staging_gate as kg  # noqa: E402
import k8s_staging_scrub as sc  # noqa: E402

TO_TREE = "tree-to"
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
    guard: Callable[[], None]
    checks: dict[str, Callable[[], bool]] = field(default_factory=dict)


def run(stages: Stages, from_ref: str | None, to_ref: str) -> dict[str, bool]:
    """Restore, deploy over it, the guard, then every check."""
    stages.restore(from_ref)
    stages.deploy(to_ref)
    stages.guard()
    return {name: check() for name, check in stages.checks.items()}


def guard_again(docker) -> tuple[list[str], str]:
    """The scrub's guard after the new release's migration; returns the panels
    left in service (each one a local copy) and the database's time now."""
    if not sc.guard(sc.Local.running(docker)):
        raise ks.StagingError("a real panel address is in staging's copy: the twin stops here")
    ids = [row["id"] for row in sc.panel_rows() if not row["retiredAt"]]
    print(f"{len(ids)} panels in service, each a local copy")
    return ids, sc.psql("SELECT now();").strip()


def panels_collected(ids: list[str], since: str) -> bool:
    """Each pointed panel collected from after `since`: production's drivers answered."""
    if not ids:
        print("no panel of production's names a local copy: nothing to collect from")
        return False
    listed = ", ".join(sc.sql_text(i) for i in ids)
    deadline = time.monotonic() + PANEL_WAIT_S
    while True:
        late = sc.psql(f'SELECT name FROM network.panel WHERE id IN ({listed}) AND '
                    f'("lastSuccessfulCollectionAt" IS NULL OR "lastSuccessfulCollectionAt" <= {sc.sql_text(since)});')
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


def chosen(checks: dict[str, Callable[[], bool]], names) -> dict[str, Callable[[], bool]]:
    """The checks named, in the twin's own order; `ready` always, since every other one
    reads a running release."""
    unknown = set(names) - set(checks)
    if unknown:
        raise ks.StagingError(f"no such twin check: {', '.join(sorted(unknown))} ({', '.join(checks)})")
    wanted = {"ready", *names}
    return {name: check for name, check in checks.items() if name in wanted}


def deploy_over(docker, ref: str) -> None:
    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", f"{ref}^{{commit}}"],
                            check=True, text=True, capture_output=True).stdout.strip()
    tree = kd.worktree(commit, TO_TREE)
    env = kd.staging_env(docker)
    kd.bring_images(docker, tree, env)
    subprocess.run([f"{tree}/scripts/prod.k8s.sh", "deploy"], env=env, check=True)
    # The deploy wrote production's env again: aimed at the gate once more (R18).
    kg.aim(sc.KUBECTL, restart=True)


def twin(docker, prod: kd.Production, from_ref: str | None, to_ref: str, names=None) -> bool:
    pointed: dict = {}

    def do_guard():
        pointed["ids"], pointed["since"] = guard_again(docker)

    def roll():
        wait_quiet(lambda: os.getloadavg()[0], os.cpu_count() or 1)
        return rehearsal_check(docker, "roll")

    checks = {"ready": lambda: rehearsal_check(docker, "ready"),
              "panels": lambda: panels_collected(pointed["ids"], pointed["since"]),
              "roll": roll, "stores": lambda: rehearsal_check(docker, "stores")}
    checks = chosen(checks, checks if names is None else names)
    stages = Stages(restore=lambda ref: kd.restore_production(docker, prod, ref),
                    deploy=lambda ref: deploy_over(docker, ref), guard=do_guard, checks=checks)
    try:
        results = run(stages, from_ref, to_ref)
    finally:
        kd.forget(docker)
    for name, ok in results.items():
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    return all(results.values())
