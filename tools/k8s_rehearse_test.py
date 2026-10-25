#!/usr/bin/env python3
"""Spec for the rehearsal's proof (OPS-1-o-f, hosting K12).

    python3 tools/k8s_rehearse_test.py
"""
import subprocess
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_rehearse as kr  # noqa: E402

REPO = Path(__file__).resolve().parent.parent


def workload(kind, name, replicas, ready, namespace="txnet"):
    status = ({"desiredNumberScheduled": replicas, "numberReady": ready} if kind == "DaemonSet"
              else {"readyReplicas": ready} if ready else {})
    return {"kind": kind, "metadata": {"name": name, "namespace": namespace},
            "spec": {} if kind == "DaemonSet" else {"replicas": replicas}, "status": status}


def route(name, backend, match):
    return {"kind": "IngressRoute", "metadata": {"name": name, "namespace": "txnet"},
            "spec": {"entryPoints": ["websecure"], "routes": [{"match": match, "services": [{"name": backend}]}]}}


# K12 (OPS-1-o-f): main-db is SIGKILLed, no shutdown at all. `crictl stop
# --timeout 0` made crictl 1.34's own call deadline zero: on the test server it
# failed "context deadline exceeded", and left a container running once.
class KillTest(unittest.TestCase):
    def test_main_db_gets_sigkill_from_its_pid(self):
        calls, killed = [], []
        counts = iter([0, 1])

        def run(argv, **_):
            calls.append(argv)
            out = "c0ffee\n" if "ps" in argv else "4242\n" if "inspect" in argv else ""
            return subprocess.CompletedProcess(argv, 0, stdout=out)
        saved = (kr.subprocess.run, kr.os.kill, kr.restarts, kr.kube, kr.workload, kr.say)
        kr.subprocess.run, kr.os.kill = run, lambda pid, sig: killed.append((pid, sig))
        kr.restarts, kr.kube = lambda *_: next(counts), lambda *_: ""
        kr.workload, kr.say = lambda _: ["statefulset/main-db"], lambda _: None
        try:
            kr.kill_postgres()
        finally:
            (kr.subprocess.run, kr.os.kill, kr.restarts, kr.kube, kr.workload, kr.say) = saved
        self.assertEqual(killed, [(4242, kr.signal.SIGKILL)])
        self.assertFalse([a for a in calls if "stop" in a])


# K12 (OPS-1-o-f): a run that failed mid-step left its queued message behind;
# the next run queued a second, counted 2 and reported rabbitmq LOST.
class MarkersTest(unittest.TestCase):
    class Stores(kr.Markers):
        """The three stores in memory, a message left by an aborted run already queued."""
        def __init__(self, left=("left-over",)):
            self.rows, self.keys, self.queue = set(), {}, list(left) or None

        def sql(self, statement):
            if statement.startswith("DROP"):
                self.rows.clear()
            elif "INSERT" in statement:
                self.rows.add(statement.split("'")[1])
            return "1" if statement.startswith("SELECT") and statement.split("'")[1] in self.rows else ""

        def redis(self, *args):
            if args[0] == "SET":
                self.keys[args[1]] = args[2]
            elif args[0] == "DEL":
                self.keys.pop(args[1], None)
            return self.keys.get(args[1], "")

        def mq(self, method, path, body=None):
            if method != "PUT" and self.queue is None:  # what the management API answers for no queue
                raise kr.urllib.error.HTTPError(path, 404, "Not Found", {}, None)
            if method == "DELETE":
                self.queue = None
            elif method == "PUT":
                self.queue = self.queue if self.queue is not None else []
            elif method == "POST":
                self.queue.append(body["payload"])
            return {"messages": len(self.queue)} if method == "GET" else {}

    def test_what_an_aborted_run_left_is_cleared_first(self):
        stores = self.Stores()
        stores.write("t1")
        self.assertEqual(stores.read("t1"), {"main-db": True, "memory-data": True, "rabbitmq": True})

    # The usual case: the run before cleaned up, so there is no queue to delete.
    def test_nothing_left_is_nothing_to_clear(self):
        stores = self.Stores(left=())
        stores.write("t1")
        self.assertEqual(stores.read("t1")["rabbitmq"], True)
        stores.remove()


class ReadyTest(unittest.TestCase):
    def test_short_workloads_are_named(self):
        listing = {"items": [workload("Deployment", "billing-service", 1, 1),
                             workload("StatefulSet", "main-db", 1, 0),
                             workload("DaemonSet", "promtail", 1, 0, "txnet-monitoring")]}
        self.assertEqual(kr.not_ready(listing), ["txnet/statefulset/main-db 0/1",
                                                 "txnet-monitoring/daemonset/promtail 0/1"])

    def test_zero_replicas_is_ready(self):
        self.assertEqual(kr.not_ready({"items": [workload("Deployment", "translator-llm", 0, 0)]}), [])


class RollTest(unittest.TestCase):
    def test_only_routes_to_the_rolled_service(self):
        objects = [route("billing", "billing-service", "Host(`api.example`) && PathPrefix(`/api/billing`)"),
                   route("auth", "auth-service", "Host(`api.example`) && PathPrefix(`/api/auth`)")]
        requests = kr.routes_to(objects, "billing-service", "api.example")
        self.assertEqual([(r.host, r.path, r.scheme) for r in requests], [("api.example", "/api/billing", "https")])

    def test_a_5xx_or_no_answer_fails_a_4xx_does_not(self):
        self.assertEqual(kr.failed(Counter({"200": 40, "401": 9, "404": 1})), 0)
        self.assertEqual(kr.failed(Counter({"200": 40, "502": 2, "000": 1})), 3)


class BundleTest(unittest.TestCase):
    def test_the_made_bundle_is_read_from_backup_now(self):
        out = ("backup: stopping nothing\n"
               "backup: /var/backups/txnet/bundles/txnet-backup-prodtxnet-20261024_190000Z.tar.zst.gpg (12 MB, 40s)\n"
               "backup: 120 tables, 3+0 Redis keys, 1 queued messages, 2 file volumes, 9 keys and env files\n")
        self.assertEqual(kr.bundle_path(out),
                         "/var/backups/txnet/bundles/txnet-backup-prodtxnet-20261024_190000Z.tar.zst.gpg")

    def test_no_bundle_named_fails(self):
        with self.assertRaises(RuntimeError):
            kr.bundle_path("backup: nothing\n")


if __name__ == "__main__":
    unittest.main()
