#!/usr/bin/env python3
"""The memory fit of production on its k3s node (OPS-1-o-n, hosting K19, ADR-0163).

    python3 tools/k8s_memfit.py sample [--rounds N] [--interval S] >> stats.tsv
    python3 tools/k8s_memfit.py report [stats.tsv ...] [--node-mib N]

`sample` appends `docker stats` lines, one per container per round; run it on the
host while the stack takes a load. `report` reads both stacks' compose models
(the renderer's own, K2) and checks each workload's `mem_reservation` (its k8s
request) and `mem_limit`: every workload has both, the requests plus the host's
and k3s's own use fit the node, and — given samples — no measured peak is above
its request or its limit. Exit 1 names each problem.
"""
import argparse
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from k8s_render import REPO, load_model  # noqa: E402
from k8srender.tables import PROVIDED_BY_KUBERNETES, SIDECARS, STACKS  # noqa: E402

# Measured 2026-10-24 (OPS-1-o-n): the test server's own use with Docker idle and
# no container; k3s v1.34 with its system pods; and what each further pod adds
# (its shim, its pause container, the kubelet's share), from 30 pause pods.
HOST_BASE_MIB = 789
K3S_BASE_MIB = 456
K3S_PER_POD_MIB = 7.5
# The test server, which ADR-0163 makes production: `free -m`'s total.
TEST_SERVER_MIB = 11959

_UNITS = {"B": 1 / 2**20, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "kB": 1e3 / 2**20, "MB": 1e6 / 2**20,
          "GB": 1e9 / 2**20}
_QUANTITY = re.compile(r"([\d.]+)\s*([A-Za-z]+)")
_STATS_FORMAT = "{{.Name}}\t{{.MemUsage}}"
_SAMPLE_ROUNDS, _SAMPLE_INTERVAL_S = 12, 20


@dataclass(frozen=True)
class Workload:
    name: str
    container: str
    request: float | None  # MiB
    limit: float | None
    pod: bool  # False for a sidecar: its container joins another pod (K3)


@dataclass(frozen=True)
class Report:
    rows: list[tuple[str, float | None, float | None, float | None]]  # name, peak, request, limit
    requested: float
    overhead: float
    problems: list[str]


def parse_mib(text: str) -> float:
    """A `docker stats` quantity (`1.079GiB`, `512KiB`) in MiB."""
    match = _QUANTITY.match(text.strip())
    if not match or match[2] not in _UNITS:
        raise ValueError(f"not a memory quantity: {text!r}")
    return float(match[1]) * _UNITS[match[2]]


def peaks(lines) -> dict[str, float]:
    """The highest use per container. A line ends `<container>\\t<used> / <total>`;
    columns before those two (a phase, a time) are ignored."""
    out: dict[str, float] = {}
    for line in lines:
        fields = line.rstrip("\n").split("\t")
        if len(fields) < 2 or "/" not in fields[-1]:
            continue
        used = parse_mib(fields[-1].split("/")[0])
        out[fields[-2]] = max(out.get(fields[-2], 0.0), used)
    return out


def _mib(value) -> float | None:
    return int(value) / 2**20 if value else None


def workloads(services: dict) -> list[Workload]:
    """The long-running containers of one compose model: a run-once Job (a profiled
    service, K8) and what Kubernetes itself provides (K11) are left out."""
    return [Workload(name, s.get("container_name") or name, _mib(s.get("mem_reservation")),
                     _mib(s.get("mem_limit")), name not in SIDECARS)
            for name, s in sorted(services.items())
            if not s.get("profiles") and name not in PROVIDED_BY_KUBERNETES]


def overhead(ws: list[Workload]) -> float:
    """What the node uses besides the requests: itself, k3s, and k3s per pod."""
    return HOST_BASE_MIB + K3S_BASE_MIB + K3S_PER_POD_MIB * sum(w.pod for w in ws)


def fit(ws: list[Workload], measured: dict[str, float], node_mib: float) -> Report:
    problems, rows = [], []
    for w in ws:
        peak = measured.get(w.container)
        rows.append((w.name, peak, w.request, w.limit))
        if w.request is None or w.limit is None:
            problems += [f"{w.name}: no {key}" for key, v in (("mem_reservation", w.request),
                                                              ("mem_limit", w.limit)) if v is None]
            continue
        if w.request > w.limit:
            problems.append(f"{w.name}: mem_reservation {w.request:.0f} above mem_limit {w.limit:.0f}")
        if peak is not None and peak >= w.limit:
            problems.append(f"{w.name}: measured {peak:.0f} MiB reaches its limit {w.limit:.0f}: OOM-killed")
        elif peak is not None and peak > w.request:
            problems.append(f"{w.name}: measured {peak:.0f} MiB above its request {w.request:.0f}")
    requested = sum(w.request or 0 for w in ws)
    extra = overhead(ws)
    if requested + extra > node_mib:
        problems.append(f"requests {requested:.0f} + host and k3s {extra:.0f} MiB are over the node's {node_mib:.0f}")
    return Report(rows, requested, extra, problems)


def repo_workloads() -> list[Workload]:
    """Both stacks as the renderer reads them. A stack's env file that is not in
    the checkout (monitoring's `.env.prod` lives on the node) is skipped: no memory
    value is interpolated."""
    out = []
    for stack in STACKS.values():
        env_files = [f for f in stack.env_files if (REPO / f).exists()]
        out += workloads(load_model(stack, env_files, {"ENVIRONMENT": "prod"})["services"])
    return out


def sample(rounds: int, interval: float) -> None:
    for i in range(rounds):
        stats = subprocess.run(["docker", "stats", "--no-stream", "--format", _STATS_FORMAT],
                               check=True, capture_output=True, text=True).stdout
        sys.stdout.write("".join(f"{int(time.time())}\t{line}\n" for line in stats.splitlines()))
        sys.stdout.flush()
        if i + 1 < rounds:
            time.sleep(interval)


def print_report(report: Report, node_mib: float) -> None:
    def cell(v):
        return f"{v:8.0f}" if v is not None else "       -"
    print(f"{'workload':28s}     peak  request    limit   (MiB)")
    for name, peak, request, limit in report.rows:
        print(f"{name:28s} {cell(peak)} {cell(request)} {cell(limit)}")
    total = report.requested + report.overhead
    print(f"requests {report.requested:.0f} + host and k3s {report.overhead:.0f} = {total:.0f} of {node_mib:.0f} MiB"
          f" ({node_mib - total:.0f} free)")
    for problem in report.problems:
        print(f"PROBLEM {problem}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sample", help="append docker stats lines to stdout")
    s.add_argument("--rounds", type=int, default=_SAMPLE_ROUNDS)
    s.add_argument("--interval", type=float, default=_SAMPLE_INTERVAL_S)
    r = sub.add_parser("report", help="check the reservations and limits, against samples if given")
    r.add_argument("stats", nargs="*", type=Path)
    r.add_argument("--node-mib", type=float, default=TEST_SERVER_MIB)
    args = parser.parse_args()
    if args.command == "sample":
        sample(args.rounds, args.interval)
        return 0
    measured: dict[str, float] = {}
    for path in args.stats:
        for container, peak in peaks(path.read_text().splitlines()).items():
            measured[container] = max(measured.get(container, 0.0), peak)
    report = fit(repo_workloads(), measured, args.node_mib)
    print_report(report, args.node_mib)
    return 1 if report.problems else 0


if __name__ == "__main__":
    sys.exit(main())
