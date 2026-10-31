#!/usr/bin/env python3
"""Spec for the staging cluster on the dev host (OPS-1-ah-a, ADR-0166).

    python3 tools/k8s_staging_test.py
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging as ks  # noqa: E402
from k8s_memfit import Workload  # noqa: E402


class Docker:
    """A stand-in for the docker CLI: records each argv, answers from a table."""

    def __init__(self, answers=None):
        self.calls, self.answers = [], answers or {}

    def __call__(self, argv, check=True, **_):
        self.calls.append(argv)
        for prefix, (code, out) in self.answers.items():
            if " ".join(argv).startswith(prefix):
                if check and code:
                    raise subprocess.CalledProcessError(code, argv, out)
                return subprocess.CompletedProcess(argv, code, out, "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def ran(self, prefix):
        return [c for c in self.calls if " ".join(c).startswith(prefix)]


class ImageTest(unittest.TestCase):
    def test_k3s_tag_is_the_pin_with_a_dash(self):
        self.assertEqual(ks.k3s_image("docker.arvancloud.ir", "v1.34.1+k3s1"),
                         "docker.arvancloud.ir/rancher/k3s:v1.34.1-k3s1")

    def test_airgap_sum_is_read_from_the_release_list(self):
        sums = ("aa11  k3s\n"
                f"bb22  {ks.AIRGAP_FILE}\n"
                "cc33  k3s-airgap-images-amd64.tar.gz\n")
        self.assertEqual(ks.airgap_sha256(sums), "bb22")

    def test_a_release_without_the_airgap_file_is_refused(self):
        with self.assertRaisesRegex(ks.StagingError, ks.AIRGAP_FILE):
            ks.airgap_sha256("aa11  k3s\n")


class RunTest(unittest.TestCase):
    def setUp(self):
        self.argv = ks.run_argv("img:tag", Path("/repo"), Path("/cache/a.tar.zst"))

    def test_on_the_internal_network_and_publishing_nothing(self):
        self.assertIn(f"--network={ks.NETWORK}", self.argv)
        self.assertFalse([a for a in self.argv if a in ("-p", "--publish") or a.startswith("--publish")])

    # ADR-0166 point 1: the twin runs production's own server flags.
    def test_production_server_config_mounted_read_only(self):
        self.assertIn("/repo/k8s/k3s/config.yaml:/etc/rancher/k3s/config.yaml:ro", self.argv)

    def test_airgap_images_where_k3s_imports_them(self):
        self.assertIn(f"/cache/a.tar.zst:{ks.AIRGAP_DIR}/{ks.AIRGAP_FILE}:ro", self.argv)

    # A named volume, so `down` removes exactly it (an anonymous one outlived the
    # 2026-10-24 proof and `docker volume prune` is never run here).
    def test_state_in_the_named_volume(self):
        self.assertIn(f"{ks.VOLUME}:/var/lib/rancher/k3s", self.argv)

    def test_the_image_store_on_its_own_kept_volume(self):
        self.assertIn(f"{ks.ki.IMAGES_VOLUME}:{ks.ki.CONTAINERD_DIR}", self.argv)

    # 2026-10-29: at 88% disk the kubelet's image GC deleted 18 of 36 imported
    # images before their pods started; with no route out none came back.
    def test_the_kubelet_never_deletes_an_image_it_cannot_pull_again(self):
        self.assertIn("--kubelet-arg=image-gc-high-threshold=100", self.argv[-1])
        self.assertIn("--kubelet-arg=image-gc-low-threshold=99", self.argv[-1])

    # k3s exits "no default routes found" on an internal network (2026-10-29): a
    # route on the container's own link, with no gateway behind it, satisfies it.
    def test_a_default_route_with_no_gateway_before_k3s_starts(self):
        self.assertEqual(self.argv[-3:-1], ["img:tag", "-c"])
        self.assertTrue(self.argv[-1].startswith("ip route add default dev eth0 && exec /bin/k3s server"))


class SubnetTest(unittest.TestCase):
    # 2026-10-29: network-service's egress guard (ADR-0095) refused the local
    # panels at 172.24.0.x, rightly: a reseller's panel never reaches a private
    # address. TEST-NET-3 is neither private nor routed anywhere (RFC 5737).
    def test_the_network_is_internal_on_a_range_no_guard_calls_private(self):
        import ipaddress
        docker = Docker()
        ks.create_network(docker)
        self.assertEqual(docker.calls, [["docker", "network", "create", "--internal",
                                         f"--subnet={ks.STAGING_SUBNET}", ks.NETWORK]])
        net = ipaddress.ip_network(ks.STAGING_SUBNET)
        # Go's netip.IsPrivate, which the guard uses (Python's is_private is wider)
        rfc1918 = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
        self.assertFalse([n for n in rfc1918 if net.overlaps(n)])
        self.assertTrue(net.subnet_of(ipaddress.ip_network("203.0.113.0/24")))


class EgressTest(unittest.TestCase):
    def network(self, internal):
        return {f"docker network inspect {ks.NETWORK}": (0, json.dumps([{"Internal": internal}]))}

    def test_closed_when_internal_and_the_probe_fails(self):
        docker = Docker({**self.network(True), "docker exec": (1, "")})
        self.assertIsNone(ks.egress_problem(docker))

    def test_a_network_with_a_route_out_is_named(self):
        docker = Docker({**self.network(False), "docker exec": (1, "")})
        self.assertIn("not internal", ks.egress_problem(docker))

    def test_an_answer_from_outside_is_named(self):
        docker = Docker({**self.network(True), "docker exec": (0, "")})
        self.assertIn(ks.EGRESS_PROBE_URL, ks.egress_problem(docker))


class FitTest(unittest.TestCase):
    WS = [Workload("a", "a", 1000.0, 2000.0, True), Workload("b", "b", 500.0, 900.0, False)]

    def test_requests_and_k3s_against_what_is_free(self):
        need = 1500 + ks.K3S_BASE_MIB + ks.K3S_PER_POD_MIB * 1
        self.assertIsNone(ks.fit_problem(self.WS, available_mib=need + 1))
        self.assertIn(f"{need:.0f}", ks.fit_problem(self.WS, available_mib=need - 1))


class DiskTest(unittest.TestCase):
    # 2026-10-29: at 90% the kubelet's DiskPressure evicted pods and deleted 8 of
    # 36 images (GC off or not); with no route out the deploy could not recover.
    GIB = 1 << 30

    # One number: the line `up` keeps clear of is the line staging's kubelet evicts at.
    def test_the_kubelet_evicts_at_the_line_up_checks(self):
        # As sh reads it: an unquoted `<` would be a redirect and k3s never start.
        server = ks.run_argv("img:tag", Path("/repo"), Path("/cache/a.tar.zst"))[-1].split(" && ", 1)[1]
        with tempfile.TemporaryDirectory() as d:
            words = subprocess.run(["sh", "-c", server.replace("exec /bin/k3s server", "printf '%s\\n'")],
                                   cwd=d, capture_output=True, text=True).stdout.splitlines()
        percent = f"{ks.EVICTION_FREE_FRACTION:.0%}"
        self.assertIn(f"--kubelet-arg=eviction-hard=imagefs.available<{percent},nodefs.available<{percent}", words)
        self.assertLess(ks.EVICTION_FREE_FRACTION, 0.15)

    def test_room_for_the_kubelets_margin_and_stagings_peak(self):
        total = 117 * self.GIB
        need = total * ks.EVICTION_FREE_FRACTION + ks.STAGING_PEAK_GIB * self.GIB
        self.assertIsNone(ks.disk_problem(total, free=int(need) + 1))
        self.assertIn("GiB", ks.disk_problem(total, free=int(need) - self.GIB))

    def test_images_kept_from_the_last_release_are_part_of_the_peak(self):
        # OPS-1-ah-e: they are already on the disk, so they need no new room.
        total = 117 * self.GIB
        need = total * ks.EVICTION_FREE_FRACTION + ks.STAGING_PEAK_GIB * self.GIB
        self.assertIsNone(ks.disk_problem(total, free=int(need) + 1 - 5 * self.GIB, held=5 * self.GIB))


class KubectlTest(unittest.TestCase):
    # Move rehearsal 2026-10-31: on a host that is no k3s node the wrapper's
    # `exec k3s kubectl` found no k3s, and every deploy into staging failed.
    def test_kubectl_is_the_staging_image_s_own_k3s_not_the_host_s(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            saved = ks.KUBECONFIG, ks.KUBECTL_WRAPPER, ks.K3S_CLIENT
            ks.KUBECONFIG, ks.KUBECTL_WRAPPER, ks.K3S_CLIENT = cache / "kc", cache / "kubectl", cache / "k3s"
            try:
                docker = Docker({f"docker exec {ks.CONTAINER} cat": (0, "server: https://127.0.0.1:6443\n")})
                ks.write_kubeconfig(docker)
                wrapper = ks.KUBECTL_WRAPPER.read_text()
            finally:
                ks.KUBECONFIG, ks.KUBECTL_WRAPPER, ks.K3S_CLIENT = saved
        self.assertEqual(docker.ran("docker cp"), [["docker", "cp", f"{ks.CONTAINER}:/bin/k3s", str(cache / "k3s")]])
        self.assertIn(f"exec {cache / 'k3s'} kubectl", wrapper)


class ImportTest(unittest.TestCase):
    # A second deploy named the same 36 images, and all were copied in again (~10 min).
    def test_an_image_staging_holds_is_not_copied_again(self):
        held = "docker.arvancloud.ir/redis:8.8-alpine\nregistry.example/txnet/a:1\n"
        docker = Docker({f"docker exec {ks.CONTAINER} ctr -n k8s.io images ls -q": (0, held)})
        self.assertEqual(ks.not_held(docker, ["registry.example/txnet/a:1", "registry.example/txnet/b:2"]),
                         ["registry.example/txnet/b:2"])


class PanelsTest(unittest.TestCase):
    # marzban-web lives in marzban's namespace (network_mode: service:marzban):
    # Docker refuses to connect it to a network, and on 2026-10-29 that ended `up`.
    def test_a_container_sharing_another_ones_network_is_left_out(self):
        listing = "paneltest-marzban-1 paneltest_default\npaneltest-marzban-web-1 \nxui2 paneltest_default\n"
        docker = Docker({"docker ps": (0, listing)})
        self.assertEqual(ks.paneltest_containers(docker), ["paneltest-marzban-1", "xui2"])


class PauseTest(unittest.TestCase):
    # `remove` deletes real paths: a test run beside a live staging must not take them.
    def setUp(self):
        import k8s_staging_data as kd
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        patches = [(ks, "KUBECONFIG", base / "kubeconfig"), (ks, "KUBECTL_WRAPPER", base / "kubectl"),
                   (kd, "SHM_DIR", base / "shm"), (kd, "AGE_KEY_FILE", str(base / "age.key"))]
        self.saved = [(m, name, getattr(m, name)) for m, name, _ in patches]
        for module, name, value in patches:
            setattr(module, name, value)

    def tearDown(self):
        for module, name, value in self.saved:
            setattr(module, name, value)
        self.tmp.cleanup()

    def test_down_starts_the_dev_stack_only_when_up_stopped_it(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d) / "staging.json"
            for was_running, started in ((True, 1), (False, 0)):
                ks.write_state(state, dev_stack_was_running=was_running)
                docker = Docker()
                ks.remove(docker, Path("/repo"), state)
                self.assertEqual(len(docker.ran("/repo/scripts/dev.compose.sh start")), started)
                self.assertFalse(state.exists())

    def test_down_removes_container_volume_and_network(self):
        with tempfile.TemporaryDirectory() as d:
            docker = Docker()
            ks.remove(docker, Path("/repo"), Path(d) / "none.json")
            for prefix in (f"docker rm -f -v {ks.CONTAINER}", f"docker volume rm {ks.VOLUME}",
                           f"docker network rm {ks.NETWORK}"):
                self.assertTrue(docker.ran(prefix), prefix)

    def test_down_drains_before_the_node_goes_and_seals_after(self):
        # The drain needs the node's containerd; compaction needs it stopped.
        with tempfile.TemporaryDirectory() as d:
            docker, seen = Docker(), []
            saved = ks.ki.keep, ks.ki.seal
            ks.ki.keep = lambda dk, node: seen.append(("keep", len(dk.calls))) or True
            ks.ki.seal = lambda dk: seen.append(("seal", len(dk.calls))) or True
            try:
                ks.remove(docker, Path("/repo"), Path(d) / "none.json")
            finally:
                ks.ki.keep, ks.ki.seal = saved
            self.assertEqual(seen[0], ("keep", 0))
            self.assertEqual(docker.calls[0], ["docker", "rm", "-f", "-v", ks.CONTAINER])
            self.assertEqual(seen[1], ("seal", 1))

    def test_down_removes_the_k3s_images_anonymous_volumes(self):
        # 2026-10-30: `rm -f` without -v left /var/log and /var/lib/kubelet of every
        # run since 2026-10-29 behind, 397 txnet pods' logs among them.
        with tempfile.TemporaryDirectory() as d:
            docker = Docker()
            ks.remove(docker, Path("/repo"), Path(d) / "none.json")
            self.assertTrue(docker.ran(f"docker rm -f -v {ks.CONTAINER}"))


if __name__ == "__main__":
    unittest.main()
