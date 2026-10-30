#!/usr/bin/env python3
"""A release from the dev host, in three commands (hosting R15, R19; ADR-0166 point 5, ADR-0168 point 4).

    scripts/release.sh [--until STEP] [--from REF]   prove: build, twin, staging left up
    scripts/release.sh approve                        the owner, in a terminal
    scripts/release.sh send                           push, ship, deploy

Each step in order; the first that fails stops there, and nothing after it runs.
Production never goes on its own: `prove` ends with staging up for the owner to
test, `approve` records the owner's word for that same commit, and only `send`
pushes, and only for that commit.

  prove
    clean    a checkout git calls unchanged, on master (R5: a release is a commit)
    checks   the repo's seven checks (AGENTS.md "Before declaring any work done")
    disk     build cache and dangling images freed, then staging's peak must fit (R14)
    build    the images whose source's tag the registry lacks (R4, R12)
    twin     staging up, production's data at its running commit, HEAD over it,
             every check (R14); a pass is recorded and staging stays up, a failure
             takes staging down and the dev stack comes back
  send
    approved the record names HEAD, the owner approved it, production has not moved
    push     the images the twin passed (R10)
    ship     production's checkout fast-forwarded to HEAD by a git bundle over ssh
    deploy   `prod.k8s.sh deploy` there (K10, K16: a failure sets every workload back)
    close    staging down, the dev stack back, the record spent

--until STEP stops `prove` after STEP. --from REF starts the twin at REF instead
of production's commit, for a commit that cannot start in staging (before
21c9d8f8 the translator and locale-service's healthcheck need an outside DNS).
"""
import argparse
import getpass
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime, timezone
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging as ks  # noqa: E402
import k8s_staging_data as kd  # noqa: E402
from bundle_plan import parse_env  # noqa: E402

PROVE_STEPS = ("clean", "checks", "disk", "build", "twin")
SEND_STEPS = ("approved", "push", "ship", "deploy", "close")
# What a passed twin proved, and the owner's approval of it; beside staging's own state.
RECORD_FILE = ks.STATE_FILE.with_name("release.json")
# How much of the commit the owner types to approve it: what `git log --oneline` shows, and more.
APPROVE_PREFIX = 12
RELEASE_BRANCH = "master"
CHECKS = ("docs-check.py", "backlog.py", "features-scan.py --check", "where.py --check",
          "conventions.py", "contracts.py", "codeshape.py")
# Where the bundle waits on production's server between `cat >` and `fetch`.
REMOTE_BUNDLE = "/tmp/txnet-release.bundle"


class ReleaseError(Exception):
    pass


@dataclass
class Step:
    name: str
    run: Callable[[], None]


def run_steps(steps: list[Step], until: str | None = None) -> str | None:
    """Runs steps in order up to `until`; the name of the one that failed, or None."""
    if until and until not in (s.name for s in steps):
        raise ReleaseError(f"--until {until}: no such step ({', '.join(s.name for s in steps)})")
    for step in steps:
        print(f"== {step.name}", flush=True)
        try:
            step.run()
        except (ReleaseError, ks.StagingError, subprocess.CalledProcessError) as error:
            print(f"release stopped at {step.name}: {error}", file=sys.stderr)
            return step.name
        if step.name == until:
            print(f"stopped after {until}, as asked")
            return None
    return None


def clean_problem(porcelain: str, branch: str) -> str | None:
    if porcelain.strip():
        return "the checkout is changed: commit or stash first (R5)\n" + porcelain
    if branch != RELEASE_BRANCH:
        return f"on {branch}, not {RELEASE_BRANCH}: only {RELEASE_BRANCH} is released"
    return None


def ancestry_problem(prod_commit: str, head: str, is_ancestor: bool) -> str | None:
    """Production only moves forward: its commit must be in HEAD's history."""
    if is_ancestor:
        return None
    return (f"production's {prod_commit[:12]} is not an ancestor of {head[:12]}: "
            "it runs work this checkout lacks, or this checkout rewrote it")


def bundle_range(prod_commit: str) -> list[str]:
    """What the bundle carries: the release branch's commits production lacks."""
    return [f"{prod_commit}..{RELEASE_BRANCH}"]


def merge_command(bundle: str, checkout: str = kd.PROD_CHECKOUT) -> str:
    return (f"git -C {checkout} fetch --quiet {bundle} {RELEASE_BRANCH} && git -C {checkout} merge --ff-only FETCH_HEAD"
            f" && rm -f {bundle}")


def deploy_command(prod: kd.Production) -> str:
    """The deploy as it has always been run there: from its checkout, its own address for K3."""
    return f"cd {kd.PROD_CHECKOUT} && HOST_GATEWAY={prod.host.rpartition('@')[2]} scripts/prod.k8s.sh deploy"


def twin_step(staging: Callable[..., bool], prod_commit: str, head: str, staging_up: bool) -> None:
    """ADR-0166 point 4: production's running commit first, HEAD over it. A pass leaves
    staging up for the owner (ADR-0168 point 4); any failure removes it, which starts
    the dev stack again (ADR-0166 point 6)."""
    passed = False
    try:
        if not staging_up and not staging("up"):
            raise ReleaseError("staging did not come up")
        if not staging("twin", "--from", prod_commit, "--to", head):
            raise ReleaseError("the twin failed: nothing was pushed, production untouched")
        passed = True
    finally:
        if not passed:
            staging("down")


def read_record(path: Path = RECORD_FILE) -> dict | None:
    """The last passed twin and its approval, or None when there is none."""
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def write_record(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2) + "\n")


def proved_problem(record: dict | None, head: str) -> str | None:
    if not record or record.get("commit") != head:
        return f"no passed twin for {head[:APPROVE_PREFIX]}: run scripts/release.sh first"
    return None


def approval_problem(record: dict | None, head: str, typed: str, is_tty: bool) -> str | None:
    """ADR-0168 point 4: the owner's word, for the commit the twin passed. A terminal is
    required because an agent's shell has none: the approval cannot be given for the owner."""
    problem = proved_problem(record, head)
    if problem:
        return problem
    if not is_tty:
        return "an approval is typed by the owner in a terminal; this has none"
    if typed.strip() != head[:APPROVE_PREFIX]:
        return f"not approved: typed {typed.strip()!r}, the commit is {head[:APPROVE_PREFIX]}"
    return None


def send_problem(record: dict | None, head: str, prod_commit: str) -> str | None:
    """Only the approved commit goes, onto the production the twin started from."""
    problem = proved_problem(record, head)
    if problem:
        return problem
    if not record.get("approved_by"):
        return f"{head[:APPROVE_PREFIX]} passed the twin but is not approved: the owner runs scripts/release.sh approve"
    if record.get("production") != prod_commit:
        return (f"production moved since the twin ({record.get('production', '?')[:12]} -> {prod_commit[:12]}): "
                "run scripts/release.sh again")
    return None


def git(*argv: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *argv], check=True, text=True, capture_output=True).stdout.strip()


def sh(argv: list[str], **kwargs) -> None:
    subprocess.run(argv, check=True, **kwargs)


def staging(*argv: str) -> bool:
    return subprocess.run(["python3", str(ROOT / "tools" / "k8s_staging.py"), *argv]).returncode == 0


def require_clean() -> None:
    problem = clean_problem(git("status", "--porcelain"), git("rev-parse", "--abbrev-ref", "HEAD"))
    if problem:
        raise ReleaseError(problem)


def run_checks() -> None:
    failed = [c for c in CHECKS if subprocess.run(["python3", str(ROOT / "tools" / c.split()[0]), *c.split()[1:]],
                                                  capture_output=True).returncode != 0]
    if failed:
        raise ReleaseError(f"failing: {', '.join(failed)} — run them for the detail")


def free_disk() -> None:
    """Never `docker volume prune`: the dev stack's and the panels' data live in volumes."""
    for argv in (["docker", "builder", "prune", "-f"], ["docker", "image", "prune", "-f"]):
        sh(argv, stdout=subprocess.DEVNULL)
    problem = ks.room_problem(ks.docker_run)
    if problem:
        raise ReleaseError(problem)


def production_commit(prod: kd.Production) -> str:
    """Production's running release: its checkout's HEAD, which `deploy` requires clean (R5)."""
    out = subprocess.run(prod.ssh(f"git -C {kd.PROD_CHECKOUT} status --porcelain; "
                                  f"git -C {kd.PROD_CHECKOUT} rev-parse HEAD"),
                         check=True, text=True, capture_output=True).stdout.splitlines()
    if len(out) != 1:
        raise ReleaseError(f"production's checkout is changed: {' '.join(out[:-1])}")
    return out[0]


def ship(prod: kd.Production, prod_commit: str, head: str) -> None:
    """prod_commit..HEAD as a git bundle over ssh; fast-forward there or nothing."""
    if prod_commit == head:
        print("production's checkout is already at HEAD")
        return
    with tempfile.TemporaryDirectory() as work:
        bundle = Path(work) / "release.bundle"
        sh(["git", "-C", str(ROOT), "bundle", "create", "--quiet", str(bundle), *bundle_range(prod_commit)])
        with open(bundle, "rb") as data:
            sh(prod.ssh(f"cat > {REMOTE_BUNDLE}"), stdin=data)
    sh(prod.ssh(merge_command(REMOTE_BUNDLE)))


def prove_steps(prod: kd.Production, twin_from: str | None = None) -> list[Step]:
    head = git("rev-parse", "HEAD")
    known: dict = {}

    def clean():
        require_clean()
        known["prod"] = production_commit(prod)
        known_here = subprocess.run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", known["prod"], head],
                                    capture_output=True).returncode == 0
        problem = ancestry_problem(known["prod"], head, known_here)
        if problem:
            raise ReleaseError(problem)

    def twin():
        # A new run spends any earlier approval before staging changes under it.
        RECORD_FILE.unlink(missing_ok=True)
        up = ks.docker_run(["docker", "inspect", ks.CONTAINER], check=False).returncode == 0
        twin_step(staging, twin_from or known["prod"], head, staging_up=up)
        write_record(RECORD_FILE, {"commit": head, "production": known["prod"], "twin_from": twin_from or known["prod"],
                                   "passed_at": now()})
        print(f"staging is up at {head[:APPROVE_PREFIX]} for the owner (scripts/staging.sh open); "
              "then scripts/release.sh approve, and scripts/release.sh send")

    prod_k8s = str(ROOT / "scripts" / "prod.k8s.sh")
    steps = {"clean": clean, "checks": run_checks, "disk": free_disk,
             "build": lambda: sh([prod_k8s, "build"]), "twin": twin}
    return [Step(name, steps[name]) for name in PROVE_STEPS]


def send_steps(prod: kd.Production) -> list[Step]:
    head = git("rev-parse", "HEAD")
    known: dict = {}

    def approved():
        require_clean()
        known["prod"] = production_commit(prod)
        problem = send_problem(read_record(), head, known["prod"])
        if problem:
            raise ReleaseError(problem)

    def close():
        staging("down")
        RECORD_FILE.unlink(missing_ok=True)

    prod_k8s = str(ROOT / "scripts" / "prod.k8s.sh")
    steps = {"approved": approved, "push": lambda: sh([prod_k8s, "push"]),
             "ship": lambda: ship(prod, known["prod"], head),
             "deploy": lambda: sh(prod.ssh(deploy_command(prod))), "close": close}
    return [Step(name, steps[name]) for name in SEND_STEPS]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def approve() -> None:
    """Records the owner's approval of the commit staging is running (ADR-0168 point 4)."""
    head = git("rev-parse", "HEAD")
    record = read_record()
    is_tty = sys.stdin.isatty()
    typed = input(f"tested in staging and approved for production? type {head[:APPROVE_PREFIX]}: ") if (
        is_tty and not proved_problem(record, head)) else ""
    problem = approval_problem(record, head, typed, is_tty)
    if problem:
        raise ReleaseError(problem)
    record.update(approved_by=os.environ.get("SUDO_USER") or getpass.getuser(), approved_at=now())
    write_record(RECORD_FILE, record)
    print(f"approved {head[:APPROVE_PREFIX]}: scripts/release.sh send")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", nargs="?", choices=("prove", "approve", "send"), default="prove")
    parser.add_argument("--until", choices=PROVE_STEPS, help="stop prove after this step")
    parser.add_argument("--from", dest="twin_from", help="the twin starts at this commit, not production's")
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print("release.py: run as root on the dev host (staging needs it)", file=sys.stderr)
        return 2
    try:
        if args.action == "approve":
            approve()
            return 0
        prod = kd.Production.from_env({**parse_env((ROOT / ".env.dev").read_text()), **os.environ})
        if args.action == "send":
            failed = run_steps(send_steps(prod))
        else:
            failed = run_steps(prove_steps(prod, args.twin_from), args.until)
    except (ReleaseError, ks.StagingError, subprocess.CalledProcessError) as error:
        print(f"release.py: {error}", file=sys.stderr)
        return 1
    if failed:
        return 1
    if args.action == "send":
        print("released")
    return 0


if __name__ == "__main__":
    sys.exit(main())
