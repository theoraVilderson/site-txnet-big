"""OPS-1-o-k: the backup bundle on Kubernetes — made, restored and shipped through kubectl and claims.

Run: python3 -m unittest scripts/bundle/test_bundle_k8s.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import bundle_k8s as bk  # noqa: E402
import bundle_plan as bp  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "move"))
import move_hosts as mh  # noqa: E402


class Workloads(unittest.TestCase):
    def test_a_store_is_its_statefulset_and_a_sidecar_rides_in_its_owners_pod(self):
        self.assertEqual(bk.workload("main-db"), ("statefulset/main-db", "main-db"))
        # K3: pg-backup is a second container in main-db's pod
        self.assertEqual(bk.workload("pg-backup"), ("statefulset/main-db", "pg-backup"))
        self.assertEqual(bk.workload("billing-service"), ("deployment/billing-service", "billing-service"))

    def test_the_replicas_to_bring_back_are_read_before_anything_stops(self):
        listed = {"items": [
            {"kind": "Deployment", "metadata": {"name": "billing-service"}, "spec": {"replicas": 1}},
            {"kind": "StatefulSet", "metadata": {"name": "main-db"}, "spec": {"replicas": 1}},
            {"kind": "Deployment", "metadata": {"name": "translator-llm"}, "spec": {"replicas": 0}},
        ]}
        self.assertEqual(bk.parse_replicas(json.dumps(listed)), {
            "deployment/billing-service": 1, "statefulset/main-db": 1, "deployment/translator-llm": 0})

    def test_a_restore_run_again_after_one_that_failed_brings_back_what_ran_before_either(self):
        # the first run scaled everything to 0; the annotation it left is the truth
        listed = {"items": [{"kind": "Deployment", "spec": {"replicas": 0}, "metadata": {
            "name": "billing-service", "annotations": {bk.REPLICAS_BEFORE: "1"}}}]}
        self.assertEqual(bk.parse_replicas(json.dumps(listed)), {"deployment/billing-service": 1})

    def test_the_forwarded_port_is_read_from_kubectls_own_line(self):
        self.assertEqual(bk.forwarded_port("Forwarding from 127.0.0.1:41235 -> 15672\n"), 41235)
        self.assertIsNone(bk.forwarded_port("Forwarding from [::1]:41235 -> 15672"))


class ScratchPod(unittest.TestCase):
    def pod(self, **kw):
        return bk.scratch_pod("txnet-bundle-abc", "registry/txnet/main-db:1", ["sh"], ["-c", "sleep 1d"], **kw)

    def test_it_is_never_part_of_the_release(self):
        # K10's prune and stop_all's wait select part-of=txnet; a scratch pod must match neither
        labels = self.pod()["metadata"]["labels"]
        self.assertNotIn("app.kubernetes.io/part-of", labels)
        self.assertEqual(self.pod()["spec"]["restartPolicy"], "Never")
        self.assertFalse(self.pod()["spec"]["automountServiceAccountToken"])

    def test_a_claim_is_mounted_at_data(self):
        spec = self.pod(claim="object-storage")["spec"]
        self.assertEqual(spec["volumes"], [{"name": "data", "persistentVolumeClaim": {"claimName": "object-storage"}}])
        self.assertEqual(spec["containers"][0]["volumeMounts"], [{"name": "data", "mountPath": "/data"}])
        self.assertNotIn("nodeName", spec)

    def test_a_host_directory_pins_the_pod_to_the_node_that_has_it(self):
        spec = self.pod(host_dir=("/var/backups/txnet/bundles", "/bundles"), node="node1")["spec"]
        self.assertEqual(spec["nodeName"], "node1")
        self.assertEqual(spec["volumes"], [{"name": "host", "hostPath": {"path": "/var/backups/txnet/bundles",
                                                                          "type": "Directory"}}])
        self.assertEqual(spec["containers"][0]["volumeMounts"],
                         [{"name": "host", "mountPath": "/bundles", "readOnly": True}])

    def test_env_is_plain_values_only(self):
        env = self.pod(env={"POSTGRES_USER": "admin", "POSTGRES_HOST_AUTH_METHOD": "trust"})["spec"]["containers"][0]["env"]
        self.assertEqual(env, [{"name": "POSTGRES_HOST_AUTH_METHOD", "value": "trust"},
                               {"name": "POSTGRES_USER", "value": "admin"}])


class HoldsData(unittest.TestCase):
    def test_a_deployed_cluster_has_seeded_rows_but_no_users(self):
        # db-migrate seeds permissions and meters; a platform with data has users
        self.assertFalse(bp.holds_users({"pg:identity.permission": 32, "pg:identity.user": 0}))
        self.assertTrue(bp.holds_users({"pg:identity.user": 3}))
        self.assertFalse(bp.holds_users({}))


class MainDatabase(unittest.TestCase):
    def test_a_bundle_whose_main_database_is_not_this_servers_is_named_before_anything_stops(self):
        # a dev bundle (devtxnet) into a cluster rendered from .env.prod restored "fine" and served nothing
        config = {"services": {"main-db": {"environment": {"POSTGRES_DB": "txnet"}}}}
        manifest = {"postgres": {"main": "devtxnet"}}
        self.assertIn("devtxnet", bp.main_database_mismatch(manifest, config))
        self.assertIsNone(bp.main_database_mismatch({"postgres": {"main": "txnet"}}, config))


class KeysOnANode(unittest.TestCase):
    def test_a_sealed_copy_is_this_servers_copy(self):
        root, opened = tempfile.mkdtemp(), tempfile.mkdtemp()
        for base, content in ((root, b"stale plaintext"), (opened, b"the sealed one")):
            os.makedirs(os.path.join(base, "dev-docker/secrets"))
            with open(os.path.join(base, "dev-docker/secrets/vault-kek"), "wb") as f:
                f.write(content)
        os.makedirs(os.path.join(root, "k8s/sealed/dev-docker/secrets"))
        open(os.path.join(root, "k8s/sealed/dev-docker/secrets/vault-kek.sops"), "w").close()
        here = bk.key_digests(root, opened, ["dev-docker/secrets/vault-kek", "dev-docker/secrets/backup-ship.env"])
        with open(os.path.join(opened, "dev-docker/secrets/vault-kek"), "rb") as f:
            self.assertEqual(here["dev-docker/secrets/vault-kek"], bk.bio.sha256_file(f.name))
        self.assertIsNone(here["dev-docker/secrets/backup-ship.env"])  # neither sealed nor here: restored


class RedisPassword(unittest.TestCase):
    def test_it_is_read_from_the_environment_the_command_expands(self):
        # OPS-1-o-i moved it out of `command`, which now names "$REDIS_PASSWORD"
        config = {"services": {"memory-data": {"command": ["sh", "-c", 'redis-server --requirepass "$REDIS_PASSWORD"'],
                                               "environment": {"REDIS_PASSWORD": "pw"}}}}
        self.assertEqual(mh.redis_password(config), "pw")


if __name__ == "__main__":
    unittest.main()
