#!/usr/bin/env python3
"""A release, start to finish, from the dev host (hosting R15, ADR-0166 point 5, OPS-1-ah-d).

    scripts/release.sh [--until STEP]

Each step in order; the first that fails stops the release there, and nothing
after it runs. The twin is the gate: no image is pushed and production is not
touched until the release passed on production's own data.

    clean    a checkout git calls unchanged, on master (R5: a release is a commit)
    checks   the repo's seven checks (AGENTS.md "Before declaring any work done")
    disk     build cache and dangling images freed, then staging's peak must fit (R14)
    build    the images whose source's tag the registry lacks (R4, R12)
    twin     staging up, production's data at its running commit, HEAD over it,
             every check (R14); staging down however it ends, the dev stack back
    push     the images the twin passed (R10)
    ship     production's checkout fast-forwarded to HEAD by a git bundle over ssh
    deploy   `prod.k8s.sh deploy` there (K10, K16: a failure sets every workload back)

--until STEP stops after STEP: `--until twin` proves a release without sending it.
--from REF starts the twin at REF instead of production's commit, for a commit
that cannot start in staging (before 21c9d8f8 the translator and locale-service's
healthcheck need an outside DNS).
"""
import argparse
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging as ks  # noqa: E402
import k8s_staging_data as kd  # noqa: E402
from bundle_plan import parse_env  # noqa: E402

STEP_NAMES = ("clean", "checks", "disk", "build", "twin", "push", "ship", "deploy")
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
    """ADR-0166 points 4, 6: production's running commit first, HEAD over it; staging
    is removed however the run ends, which starts the dev stack again."""
    try:
        if not staging_up and not staging("up"):
            raise ReleaseError("staging did not come up")
        if not staging("twin", "--from", prod_commit, "--to", head):
            raise ReleaseError("the twin failed: nothing was pushed, production untouched")
    finally:
        staging("down")


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
    disk = os.statvfs("/")
    problem = ks.disk_problem(disk.f_blocks * disk.f_frsize, disk.f_bavail * disk.f_frsize)
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


def steps(prod: kd.Production, twin_from: str | None = None) -> list[Step]:
    head = git("rev-parse", "HEAD")
    known: dict = {}

    def check_production():
        known["prod"] = production_commit(prod)
        known_here = subprocess.run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", known["prod"], head],
                                    capture_output=True).returncode == 0
        problem = ancestry_problem(known["prod"], head, known_here)
        if problem:
            raise ReleaseError(problem)

    def clean():
        require_clean()
        check_production()

    def twin():
        up = ks.docker_run(["docker", "inspect", ks.CONTAINER], check=False).returncode == 0
        twin_step(staging, twin_from or known["prod"], head, staging_up=up)

    prod_k8s = str(ROOT / "scripts" / "prod.k8s.sh")
    return [Step("clean", clean), Step("checks", run_checks), Step("disk", free_disk),
            Step("build", lambda: sh([prod_k8s, "build"])), Step("twin", twin),
            Step("push", lambda: sh([prod_k8s, "push"])), Step("ship", lambda: ship(prod, known["prod"], head)),
            Step("deploy", lambda: sh(prod.ssh(deploy_command(prod))))]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--until", choices=STEP_NAMES, help="stop after this step")
    parser.add_argument("--from", dest="twin_from", help="the twin starts at this commit, not production's")
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print("release.py: run as root on the dev host (staging needs it)", file=sys.stderr)
        return 2
    try:
        prod = kd.Production.from_env({**parse_env((ROOT / ".env.dev").read_text()), **os.environ})
        failed = run_steps(steps(prod, args.twin_from), args.until)
    except (ReleaseError, ks.StagingError) as error:
        print(f"release.py: {error}", file=sys.stderr)
        return 1
    if failed:
        return 1
    if not args.until:
        print("released")
    return 0


if __name__ == "__main__":
    sys.exit(main())
