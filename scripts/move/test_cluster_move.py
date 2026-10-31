"""OPS-1-am-a: production moves to another cluster with one writer at any moment.

Run: python3 -m unittest scripts/move/test_cluster_move.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import cluster_fence as cf  # noqa: E402


def pod(name, owner_kind, owner, phase="Running", namespace="txnet"):
    return {"metadata": {"name": name, "namespace": namespace,
                         "ownerReferences": [{"kind": owner_kind, "name": owner}]},
            "status": {"phase": phase}}


def listing(*pods):
    return json.dumps({"items": list(pods)})


class OldAtZero(unittest.TestCase):
    # The row: "old cluster at zero (workers, bots, relays, schedules) and checked so before a fresh bundle".
    def test_the_stores_alone_are_zero(self):
        pods = listing(pod("main-db-0", "StatefulSet", "main-db"), pod("rabbitmq-0", "StatefulSet", "rabbitmq"),
                       pod("memory-data-0", "StatefulSet", "memory-data"))
        self.assertEqual(cf.writers_left(pods), [])

    def test_a_bot_still_running_is_named(self):
        pods = listing(pod("main-db-0", "StatefulSet", "main-db"),
                       pod("bot-service-7c9-x2", "ReplicaSet", "bot-service-7c9"))
        self.assertEqual(cf.writers_left(pods), ["txnet/bot-service-7c9-x2"])

    def test_monitoring_sends_alerts_so_it_is_a_writer(self):
        pods = listing(pod("grafana-0", "StatefulSet", "grafana", namespace="txnet-monitoring"))
        self.assertEqual(cf.writers_left(pods), ["txnet-monitoring/grafana-0"])

    def test_a_finished_job_is_not_a_writer(self):
        pods = listing(pod("db-migrate-a1", "Job", "db-migrate", phase="Succeeded"))
        self.assertEqual(cf.writers_left(pods), [])

    def test_the_log_shipper_stops_with_k3s_not_before(self):
        pods = listing(pod("promtail-x7", "DaemonSet", "promtail", namespace="txnet-monitoring"))
        self.assertEqual(cf.writers_left(pods), [])

    def test_fenced_means_the_stores_too(self):
        pods = listing(pod("main-db-0", "StatefulSet", "main-db"))
        self.assertEqual(cf.writers_left(pods, keep=()), ["txnet/main-db-0"])

    def test_the_host_timers_that_reach_outside_are_stopped(self):
        # the nightly bundle and the ship write to the same S3 bucket the new server will
        self.assertEqual(cf.HOST_TIMERS, ("txnet-backup.timer", "txnet-backup-ship.timer"))


class BundleAfterTheStop(unittest.TestCase):
    STOP = 1793453400  # 2026-10-31T13:30:00Z

    def test_a_bundle_made_after_the_stop_passes(self):
        self.assertIsNone(cf.stale_bundle("2026-10-31T13:31:10Z", self.STOP))

    def test_last_nights_bundle_is_refused(self):
        refusal = cf.stale_bundle("2026-10-31T03:00:04Z", self.STOP)
        self.assertIn("older than the stop", refusal)


class NoScrub(unittest.TestCase):
    def test_the_restore_replaces_and_never_scrubs(self):
        argv = cf.restore_argv("/root/site-txnet-big", "/dev/shm/m/b.gpg", "/dev/shm/m/pass")
        self.assertIn("--replace", argv)
        self.assertNotIn("--scrub", argv)

    def test_staging_is_refused(self):
        self.assertIn("staging", cf.refuse_scrub({"NODE_EXEC": "docker exec txnet-staging"}))
        self.assertIsNone(cf.refuse_scrub({"PATH": "/usr/bin"}))


class Mute(unittest.TestCase):
    RULES = cf.mute_ruleset(["185.143.233.10"], ["10.202.10.10"])

    def test_everything_out_is_dropped_but_the_allowed(self):
        self.assertIn("policy drop", self.RULES)
        self.assertIn("185.143.233.10", self.RULES)
        self.assertIn("ct state established,related accept", self.RULES)

    def test_pods_are_muted_as_well_as_the_host(self):
        # a pod's traffic out is forwarded, never output
        self.assertIn("hook forward", self.RULES)
        self.assertIn("hook output", self.RULES)

    def test_dns_only_to_the_resolvers(self):
        self.assertIn("ip daddr { 10.202.10.10 } udp dport 53 accept", self.RULES)

    @unittest.skipUnless(shutil.which("nft"), "nft is not installed here")
    def test_nft_accepts_it(self):
        # rehearsal 2026-10-31: a chain named `fwd` (an nft keyword) failed at load on the new server
        with tempfile.NamedTemporaryFile("w", suffix=".nft") as f:
            f.write(self.RULES)
            f.flush()
            done = subprocess.run(["nft", "-c", "-f", f.name], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_name_is_not_an_address(self):
        with self.assertRaises(cf.MoveError):
            cf.mute_ruleset(["registry.mytxnet.ir"], [])


class Order(unittest.TestCase):
    def test_the_real_move_goes_in_order(self):
        state = {"mode": "move", "done": {s: 1 for s in cf.STEPS["move"][:4]}}
        self.assertIsNone(cf.out_of_order(state, "stop"))
        self.assertIn("`stop`", cf.out_of_order(state, "restore"))

    def test_a_rehearsal_never_stops_fences_or_repoints(self):
        state = {"mode": "rehearse", "done": {s: 1 for s in cf.STEPS["rehearse"]}}
        for step in ("stop", "fence", "open", "repoint"):
            self.assertIn("rehearsal", cf.out_of_order(state, step))

    def test_open_needs_the_old_fenced_now(self):
        self.assertIn("k3s", cf.not_fenced({"k3s": "active", "marker": "193.151.153.11"}, "193.151.153.11"))
        self.assertIn("marker", cf.not_fenced({"k3s": "inactive", "marker": ""}, "193.151.153.11"))
        self.assertIsNone(cf.not_fenced({"k3s": "inactive", "marker": "193.151.153.11"}, "193.151.153.11"))


class LiveDomain(unittest.TestCase):
    # mytxnet.ir is the user's live site: untouched without their word (OPS-1-am-d, ADR-0165)
    def test_the_live_domain_is_refused(self):
        self.assertIn("mytxnet.ir", cf.refuse_live_domain("mytxnet.ir", {}))
        self.assertIsNone(cf.refuse_live_domain("mytxnet.ir", {"MOVE_LIVE_DOMAIN_OK": "mytxnet.ir"}))
        self.assertIsNone(cf.refuse_live_domain("barghgho.ir", {}))


if __name__ == "__main__":
    unittest.main()
