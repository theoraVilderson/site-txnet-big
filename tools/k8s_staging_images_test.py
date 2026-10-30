#!/usr/bin/env python3
"""Spec for staging's image store kept between releases (OPS-1-ah-e, hosting R14).

    python3 tools/k8s_staging_images_test.py
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_images as ki  # noqa: E402

NODE = "txnet-staging"


def pods(*namespaces):
    return json.dumps({"items": [{"id": f"p{i}", "metadata": {"namespace": ns}} for i, ns in enumerate(namespaces)]})


def containers(*namespaces):
    return json.dumps({"containers": [{"id": f"c{i}", "labels": {"io.kubernetes.pod.namespace": ns}}
                                      for i, ns in enumerate(namespaces)]})


class Node:
    """A stand-in for `docker` aimed at the node: answers each crictl/kubectl from a list,
    the last answer repeating."""

    def __init__(self, running=True, pods_seen=None, containers_seen=None, namespaces="txnet kube-system"):
        self.calls, self.running = [], running
        self.pods_seen = list(pods_seen or [pods()])
        self.containers_seen = list(containers_seen or [containers()])
        self.namespaces = namespaces

    def __call__(self, argv, check=True, **_):
        self.calls.append(argv)
        line = " ".join(argv)
        out, code = "", 0
        if line.startswith("docker inspect"):
            out = "true" if self.running else ""
            code = 0 if self.running else 1
        elif "crictl pods" in line:
            out = self.pods_seen.pop(0) if len(self.pods_seen) > 1 else self.pods_seen[0]
        elif "crictl ps" in line:
            out = self.containers_seen.pop(0) if len(self.containers_seen) > 1 else self.containers_seen[0]
        elif "get namespaces" in line:
            out = self.namespaces
        if check and code:
            raise subprocess.CalledProcessError(code, argv, out)
        return subprocess.CompletedProcess(argv, code, out, "")

    def ran(self, fragment):
        return [c for c in self.calls if fragment in " ".join(c)]


class MountTest(unittest.TestCase):
    def test_containerd_alone_on_the_kept_volume(self):
        # Inside the k3s volume `down` still removes: the server's database, the
        # PVs (production's rows) and the kubelet's files are not in it.
        self.assertEqual(ki.mount_args(), ["-v", f"{ki.IMAGES_VOLUME}:/var/lib/rancher/k3s/agent/containerd"])


class LeftoverTest(unittest.TestCase):
    def test_only_the_clusters_own_namespaces_may_stay(self):
        self.assertEqual(ki.app_namespaces(["txnet", "kube-system", "txnet-monitoring", "default"]),
                         ["txnet", "txnet-monitoring"])

    def test_a_container_or_pod_of_production_is_a_leftover(self):
        self.assertEqual(ki.leftover_pods(pods("kube-system", "txnet")), ["p1"])
        self.assertEqual(ki.leftover_containers(containers("txnet-monitoring", "kube-system")), ["c0"])


class KeepTest(unittest.TestCase):
    def keep(self, node):
        return ki.keep(node, NODE, sleep=lambda _s: None)

    def test_kept_when_nothing_of_productions_is_left(self):
        node = Node(pods_seen=[pods("txnet", "kube-system"), pods("kube-system")],
                    containers_seen=[containers("kube-system")])
        self.assertTrue(self.keep(node))
        self.assertFalse(node.ran(f"docker volume rm {ki.IMAGES_VOLUME}"))

    def test_images_the_running_release_does_not_use_go_first(self):
        # The store holds one release, not every release since it was made.
        node = Node()
        self.keep(node)
        prune = node.calls.index(node.ran("crictl rmi --prune")[0])
        delete = node.calls.index(node.ran("delete namespace")[0])
        self.assertLess(prune, delete)

    def test_productions_namespaces_deleted_and_their_pods_removed(self):
        node = Node(pods_seen=[pods("txnet"), pods()])
        self.keep(node)
        self.assertEqual(node.ran("delete namespace")[0][-3:], ["txnet", "--wait=false", "--ignore-not-found"])
        self.assertTrue(node.ran("crictl rmp -f p0"))

    def test_dropped_when_a_container_of_productions_stays(self):
        node = Node(containers_seen=[containers("txnet")])
        self.assertFalse(self.keep(node))
        self.assertTrue(node.ran(f"docker volume rm {ki.IMAGES_VOLUME}"))

    def test_dropped_when_the_node_is_not_running_to_prove_it(self):
        node = Node(running=False)
        self.assertFalse(self.keep(node))
        self.assertTrue(node.ran(f"docker volume rm {ki.IMAGES_VOLUME}"))
        self.assertFalse(node.ran("crictl"))


class SealTest(unittest.TestCase):
    # 2026-10-30, live: a deleted pod's command line was still in meta.db's freed
    # pages; production's env Secrets would be too. Compaction writes live records only.
    def store(self, d):
        root = Path(d)
        for rel in ki.BOLT_FILES:
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text("old pages")
        (root / ki.CONTAINERD_LOG).write_text("log")
        return root

    def docker_at(self, root):
        def docker(argv, check=True, **_):
            out = str(root) if argv[:3] == ["docker", "volume", "inspect"] else ""
            return subprocess.CompletedProcess(argv, 0, out, "")
        return docker

    def test_every_bolt_file_rewritten_and_the_log_removed(self):
        with tempfile.TemporaryDirectory() as d:
            root, ran = self.store(d), []

            def compact(src, dst):
                ran.append(src)
                Path(dst).write_text("live records")
            self.assertTrue(ki.seal(self.docker_at(root), compact=compact))
            self.assertEqual(sorted(ran), sorted(str(root / rel) for rel in ki.BOLT_FILES))
            for rel in ki.BOLT_FILES:
                self.assertEqual((root / rel).read_text(), "live records")
            self.assertFalse((root / ki.CONTAINERD_LOG).exists())

    def test_a_failed_compaction_removes_the_store(self):
        with tempfile.TemporaryDirectory() as d:
            root, calls = self.store(d), []
            inner = self.docker_at(root)

            def docker(argv, check=True, **kw):
                calls.append(argv)
                return inner(argv, check, **kw)

            def compact(src, dst):
                raise subprocess.CalledProcessError(1, ["bbolt"])
            self.assertFalse(ki.seal(docker, compact=compact))
            self.assertIn(["docker", "volume", "rm", ki.IMAGES_VOLUME], calls)

    def test_the_tool_is_pinned(self):
        self.assertRegex(ki.BBOLT_VERSION, r"^v\d+\.\d+\.\d+$")


class RoomTest(unittest.TestCase):
    def test_the_kept_images_count_toward_stagings_peak(self):
        node = Node()
        answers = {"docker volume inspect": "/var/lib/docker/volumes/v/_data", "du": "1073741824\t/x"}

        def docker(argv, check=True, **_):
            for prefix, out in answers.items():
                if argv[0] == prefix or " ".join(argv).startswith(prefix):
                    return subprocess.CompletedProcess(argv, 0, out, "")
            return node(argv, check=check)
        self.assertEqual(ki.held_bytes(docker), 1 << 30)

    def test_no_volume_holds_nothing(self):
        def docker(argv, check=True, **_):
            return subprocess.CompletedProcess(argv, 1, "", "no such volume")
        self.assertEqual(ki.held_bytes(docker), 0)


if __name__ == "__main__":
    unittest.main()
