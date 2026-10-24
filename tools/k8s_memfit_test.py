#!/usr/bin/env python3
"""Spec for tools/k8s_memfit.py (OPS-1-o-n, hosting contract.kubernetes.md K19).

Each test feeds a small compose model and `docker stats` lines and checks one
part of the fit: the peak read, the requests against the node, a peak against
its own request and limit.

    python3 tools/k8s_memfit_test.py
"""
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_memfit as memfit  # noqa: E402

MIB = 1024 * 1024


def service(container: str, request: int | None, limit: int | None, **extra) -> dict:
    out = {"container_name": container, **extra}
    if request is not None:
        out["mem_reservation"] = request * MIB
    if limit is not None:
        out["mem_limit"] = str(limit * MIB)  # compose prints one as a number, the other as text
    return out


def model() -> dict:
    return {"services": {
        "main-db": service("txnet-prod-postgres", 768, 2048),
        "pg-backup": service("txnet-prod-pg-backup", 64, 512),
        "billing-service": service("txnet-prod-billing-service", 160, 512),
        "db-migrate": service("txnet-prod-db-migrate", None, None, profiles=["migrate"]),
        "cadvisor": service("txnet-cadvisor", None, None),
    }}


class UnitsTest(unittest.TestCase):
    # docker stats prints binary units; a loaded model reads 1.079GiB.
    def test_docker_units(self):
        self.assertAlmostEqual(memfit.parse_mib("1.079GiB"), 1104.9, places=1)
        self.assertEqual(memfit.parse_mib("370.4MiB"), 370.4)
        self.assertEqual(memfit.parse_mib("512KiB"), 0.5)
        self.assertEqual(memfit.parse_mib("0B"), 0)

    # A sample line may carry leading columns (phase, time); the peak is the highest.
    def test_peak_is_the_highest_sample(self):
        lines = ["idle\t1\ttxnet-prod-billing-service\t108MiB / 11.68GiB",
                 "load\t2\ttxnet-prod-billing-service\t119.2MiB / 11.68GiB",
                 "txnet-prod-postgres\t100MiB / 11.68GiB", ""]
        self.assertEqual(memfit.peaks(lines), {"txnet-prod-billing-service": 119.2, "txnet-prod-postgres": 100})


class FitTest(unittest.TestCase):
    def workloads(self, m=None):
        return memfit.workloads((m or model())["services"])

    # A run-once Job (K8) and a service Kubernetes provides (K11) are not workloads;
    # a sidecar adds its request to its pod, not a pod of its own (K3).
    def test_workloads_and_pods(self):
        ws = {w.name: w for w in self.workloads()}
        self.assertEqual(sorted(ws), ["billing-service", "main-db", "pg-backup"])
        self.assertFalse(ws["pg-backup"].pod)
        self.assertEqual((ws["main-db"].request, ws["main-db"].limit), (768, 2048))

    # K19: the requests, the host's own use and k3s's per pod are what the node must hold.
    def test_overhead_counts_k3s_per_pod(self):
        expected = memfit.HOST_BASE_MIB + memfit.K3S_BASE_MIB + 2 * memfit.K3S_PER_POD_MIB
        self.assertEqual(memfit.overhead(self.workloads()), expected)

    def test_fits(self):
        report = memfit.fit(self.workloads(), {"txnet-prod-billing-service": 119}, node_mib=11959)
        self.assertEqual(report.problems, [])
        self.assertEqual(report.requested, 768 + 64 + 160)

    def test_requests_over_the_node_do_not_fit(self):
        report = memfit.fit(self.workloads(), {}, node_mib=2000)
        self.assertEqual(len(report.problems), 1)
        self.assertIn("over the node's 2000", report.problems[0])

    # A peak above its request starves a neighbour the scheduler counted on;
    # above its limit, the container is OOM-killed.
    def test_a_peak_above_its_request_or_limit_is_named(self):
        report = memfit.fit(self.workloads(), {"txnet-prod-billing-service": 300, "txnet-prod-postgres": 2100},
                            node_mib=11959)
        self.assertEqual(sorted(p.split(":")[0] for p in report.problems), ["billing-service", "main-db"])
        self.assertTrue(any("OOM" in p for p in report.problems if p.startswith("main-db")))

    def test_a_workload_without_a_reservation_or_limit_is_named(self):
        m = model()
        del m["services"]["billing-service"]["mem_reservation"]
        m["services"]["pg-backup"]["mem_reservation"] = 1024 * MIB
        report = memfit.fit(self.workloads(m), {}, node_mib=11959)
        self.assertEqual(sorted(report.problems), ["billing-service: no mem_reservation",
                                                   "pg-backup: mem_reservation 1024 above mem_limit 512"])


REPO = Path(__file__).resolve().parent.parent


# K19 at HEAD: every workload of both stacks carries a reservation and a limit,
# and the requests fit the test server. A compose change that breaks it fails here.
@unittest.skipUnless(shutil.which("docker") and (REPO / ".env").exists() and (REPO / ".env.prod").exists(),
                     "needs docker compose and the repo's .env / .env.prod")
class RepoModelTest(unittest.TestCase):
    def test_the_repo_fits_the_test_server(self):
        result = subprocess.run([sys.executable, str(REPO / "tools/k8s_memfit.py"), "report"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
