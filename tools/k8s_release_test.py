#!/usr/bin/env python3
"""Spec for a release that rolls back as one (OPS-1-o-p, hosting contract.release.md).

    python3 tools/k8s_release_test.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8s_release import (Exec, Request, after_deploy, after_rollback, current, curl_argv, health_checks,  # noqa: E402
                         passed, previous, route_requests)

REPO = Path(__file__).resolve().parent.parent


def workload(kind, name, containers, *, replicas=1, namespace="txnet"):
    spec = {"template": {"spec": {"containers": containers}}}
    if kind != "DaemonSet":
        spec["replicas"] = replicas
    return {"kind": kind, "metadata": {"name": name, "namespace": namespace}, "spec": spec}


def probe(*argv, timeout=5):
    return {"exec": {"command": list(argv)}, "timeoutSeconds": timeout}


def route(name, match, entry_points, service, namespace="txnet"):
    return {"kind": "IngressRoute", "metadata": {"name": name, "namespace": namespace},
            "spec": {"entryPoints": entry_points,
                     "routes": [{"match": match, "services": [{"name": service, "port": 3000}]}]}}


# K16: each service's own health, asked the way its readiness probe asks it.
class HealthTest(unittest.TestCase):
    def test_each_container_is_asked_its_own_probe(self):
        objects = [
            workload("StatefulSet", "main-db", [
                {"name": "main-db", "readinessProbe": probe("pg_isready")},
                {"name": "pg-backup", "livenessProbe": probe("loop-health", timeout=3)}]),
            workload("DaemonSet", "promtail", [{"name": "promtail"}], namespace="txnet-monitoring"),
        ]
        self.assertEqual(health_checks(objects), [
            Exec("txnet", "statefulset/main-db", "main-db", ["pg_isready"], 5),
            Exec("txnet", "statefulset/main-db", "pg-backup", ["loop-health"], 3),
        ])

    # A workload the overlay runs at zero replicas has no pod to ask (OPS-1-o-n).
    def test_zero_replicas_is_not_asked(self):
        objects = [workload("Deployment", "ai-service", [{"name": "ai", "readinessProbe": probe("x")}], replicas=0)]
        self.assertEqual(health_checks(objects), [])


# K16: one request per IngressRoute, through Traefik, aimed at that route.
class RouteTest(unittest.TestCase):
    def test_host_path_method_and_door(self):
        objects = [
            route("dashboard-https", "Host(`monitor.x.ir`) && (PathPrefix(`/api`) || PathPrefix(`/dashboard`))",
                  ["websecure"], "gateway-handler"),
            route("billing-preflight-http", "PathPrefix(`/api/billing`) && Method(`OPTIONS`)", ["web"],
                  "billing-service"),
            route("nextjs-any", "HostRegexp(`.+`)", ["websecure"], "site-pwa"),
        ]
        self.assertEqual(route_requests(objects, "api.x.ir"), [
            Request("txnet/dashboard-https", "https", "monitor.x.ir", "/api", "GET"),
            Request("txnet/billing-preflight-http", "http", "api.x.ir", "/api/billing", "OPTIONS"),
            Request("txnet/nextjs-any", "https", "api.x.ir", "/", "GET"),
        ])

    # Its backend has no pod: Traefik's 503 there is the overlay's choice, not a failed release.
    def test_a_route_to_zero_replicas_is_not_asked(self):
        objects = [workload("Deployment", "ai-service", [{"name": "ai"}], replicas=0),
                   route("ai-service", "PathPrefix(`/api/ai`)", ["websecure"], "ai-service")]
        self.assertEqual(route_requests(objects, "api.x.ir"), [])

    # O3: 443 answers only a caller holding the origin-pull client pair, as Cloudflare does.
    def test_https_presents_the_client_pair_and_resolves_to_the_forward(self):
        argv = curl_argv(Request("txnet/r", "https", "panel.x.ir", "/a", "GET"), {"https": 18443}, Path("/shm/op"))
        self.assertIn("--resolve", argv)
        self.assertEqual(argv[argv.index("--resolve") + 1], "panel.x.ir:18443:127.0.0.1")
        self.assertEqual(argv[argv.index("--cert") + 1], "/shm/op/client.pem")
        self.assertEqual(argv[argv.index("--key") + 1], "/shm/op/client.key")
        self.assertEqual(argv[-1], "https://panel.x.ir:18443/a")

    def test_any_answer_below_500_passes(self):
        self.assertEqual([passed(code) for code in ("200", "301", "401", "404", "000", "502", "503")],
                         [True, True, True, True, False, False, False])


# K16: the release record — what runs, and what `rollback` with no tag goes back to.
class HistoryTest(unittest.TestCase):
    def test_a_deploy_appends_once_and_keeps_ten(self):
        history = [f"t{i}" for i in range(10)]
        self.assertEqual(after_deploy(history, "t3")[-2:], ["t9", "t3"])
        self.assertEqual(len(after_deploy(history, "new")), 10)
        self.assertEqual(after_deploy([], "a"), ["a"])

    def test_current_and_previous(self):
        self.assertEqual((current(["a", "b"]), previous(["a", "b"])), ("b", "a"))
        self.assertEqual((current([]), previous(["a"])), ("", ""))

    # A rollback forgets what it undid, so a second `rollback` goes further back, never forward.
    def test_a_rollback_drops_the_releases_it_undid(self):
        self.assertEqual(after_rollback(["a", "b", "c"], "a"), ["a"])
        self.assertEqual(after_rollback(["a", "b"], "z"), ["a", "b", "z"])


# Every real route's rule gives a request, so the smoke check covers each one.
class RepoRoutesTest(unittest.TestCase):
    def test_every_production_route_has_a_request(self):
        with tempfile.TemporaryDirectory() as out:
            run = subprocess.run([sys.executable, str(REPO / "tools/k8s_render.py"), f"{out}/base",
                                  "--host-gateway", "10.0.0.5", "--tag", "t1"], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            objects = [o for f in Path(out, "base").glob("*.yaml") for o in yaml.safe_load_all(f.read_text()) if o]
        routes = [o for o in objects if o["kind"] == "IngressRoute"]
        self.assertGreater(len(routes), 20)
        self.assertEqual(len(route_requests(objects, "api.x.ir")), len(routes))
        self.assertTrue(health_checks(objects))


# A kubectl that answers what deploy and rollback ask, and logs every call.
# The last manifest applied names its release; a rollout of FAKE_BAD is never ready.
FAKE_KUBECTL = r"""#!/usr/bin/env python3
import json, os, re, sys
state = os.environ["FAKE_STATE"]
argv = sys.argv[1:]
open(f"{state}/calls", "a").write(" ".join(argv) + "\n")
if argv[:1] == ["-n"]:
    argv = argv[2:]
def read(name):
    return open(f"{state}/{name}").read() if os.path.exists(f"{state}/{name}") else ""
if argv[:2] == ["get", "nodes"]:
    print("" if os.environ.get("FAKE_NO_DATA_NODE") else "node/server")
elif argv[:2] == ["get", "configmap"]:
    record = json.loads(read("record") or "{}")
    sys.exit(print(record.get(re.search(r"\.data\.(\w+)", argv[-1]).group(1), ""), end="") if record else 1)
elif argv[:2] == ["create", "configmap"]:
    print(json.dumps(dict(a.split("=", 2)[1:] for a in argv if a.startswith("--from-literal="))))
elif argv[:3] == ["apply", "-f", "-"]:
    text = sys.stdin.read()
    if text.startswith("{"):
        open(f"{state}/record", "w").write(text)
elif argv[:2] == ["apply", "-f"]:
    open(f"{state}/applied", "w").write(re.search(r"release: (\S+)", open(argv[2]).read()).group(1))
elif argv[:1] == ["exec"]:
    open(f"{state}/exec-stdin", "w").write(sys.stdin.read())
elif argv[:2] == ["rollout", "status"]:
    sys.exit(1 if read("applied") == os.environ.get("FAKE_BAD") else 0)
"""

# The parts that need sops, a render or a cluster, stubbed; the order between them is real.
STUBS = """
source "$REPO/scripts/prod.k8s.sh"
log() { echo "$*" >>"$FAKE_STATE/calls"; }
open_sealed() { OPENED="$(mktemp -d)"; TEMPS+=("$OPENED"); }
require_commit() { :; }
render_tree() { log "render $([ "$1" = "$ROOT_DIR" ] && echo checkout || echo worktree) $2"; RENDERED="$2"; }
build_manifest() {
  MANIFEST="$(mktemp)"; TEMPS+=("$MANIFEST")
  printf 'kind: Deployment\nmetadata:\n  name: billing-service\n  namespace: txnet\n  annotations:\n    release: %s\n' \
    "$RENDERED" >"$MANIFEST"
}
migrate() { log migrate; }
login_roles() { log login-roles; }
smoke_check() { log smoke; [ "$(cat "$FAKE_STATE/applied")" != "${FAKE_SMOKE_BAD:-}" ]; }
"""


def commits(n):
    return subprocess.run(["git", "-C", str(REPO), "log", f"-{n}", "--format=%h", "--abbrev=12"],
                          capture_output=True, text=True, check=True).stdout.split()


# K16 end to end with a fake kubectl: what a failure undoes, and in which order.
class ScriptTest(unittest.TestCase):
    NEW, OLD, OLDER = commits(3)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        kubectl = self.state / "kubectl"
        kubectl.write_text(FAKE_KUBECTL)
        kubectl.chmod(0o755)
        self.env = {**os.environ, "FAKE_STATE": str(self.state), "KUBECTL": str(kubectl), "REPO": str(REPO),
                    "IMAGE_TAG": self.NEW}

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, command, history=None, **env):
        if history is not None:
            (self.state / "record").write_text(json.dumps({"history": " ".join(history), "overlay": "prod"}))
        run = subprocess.run(["bash", "-c", STUBS + command], capture_output=True, text=True,
                             env={**self.env, **env})
        calls = (self.state / "calls").read_text().splitlines()
        recorded = self.state / "record"
        record = json.loads(recorded.read_text()) if recorded.exists() else {}
        return run, [c for c in calls if not c.startswith(("get ", "create ", "kustomize"))], record

    def test_a_good_deploy_is_recorded_after_its_smoke_check(self):
        run, calls, record = self.run_script("deploy prod", [self.OLD])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(record["history"], f"{self.OLD} {self.NEW}")
        self.assertLess(calls.index("smoke"), next(i for i, c in enumerate(calls) if "--prune" in c))
        # OPS-1-o-w: the migration makes the group roles the logins join; the services then log in.
        release = next(i for i, c in enumerate(calls) if c.startswith("apply -f /"))
        self.assertLess(calls.index("migrate"), calls.index("login-roles"))
        self.assertLess(calls.index("login-roles"), release)

    # The whole release goes back, rendered from the earlier commit, and db-migrate is not run again.
    def test_a_workload_not_ready_sets_the_release_back(self):
        run, calls, record = self.run_script("deploy prod", [self.OLDER, self.OLD], FAKE_BAD=self.NEW)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn(f"rolled back to {self.OLD}", run.stderr)
        self.assertIn(f"render worktree {self.OLD}", calls)
        self.assertEqual(calls.count("migrate"), 1)
        prunes = [c for c in calls if "--prune" in c]
        self.assertEqual(len(prunes), 1)
        self.assertGreater(calls.index(prunes[0]), calls.index(f"render worktree {self.OLD}"))
        self.assertEqual(record["history"], f"{self.OLDER} {self.OLD}")

    def test_a_failed_smoke_check_sets_the_release_back(self):
        run, calls, record = self.run_script("deploy prod", [self.OLD], FAKE_SMOKE_BAD=self.NEW)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn(f"render worktree {self.OLD}", calls)
        self.assertEqual(record["history"], self.OLD)

    def test_the_first_release_has_nothing_to_go_back_to(self):
        run, calls, _ = self.run_script("deploy prod", FAKE_BAD=self.NEW)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("no earlier release", run.stderr)
        self.assertTrue(any(c.startswith("-n txnet rollout undo") for c in calls))

    # K17 (OPS-1-o-q): with no node labelled for the stores, a first claim could
    # bind on any node and stay there, so nothing is applied at all.
    def test_no_data_node_applies_nothing(self):
        for command in ("deploy prod", "rollback"):
            run, calls, _ = self.run_script(command, [self.OLDER, self.OLD], FAKE_NO_DATA_NODE="1")
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("txnet.io/data=true", run.stderr)
            self.assertFalse([c for c in calls if c.startswith(("apply", "-n txnet apply"))], calls)

    # By hand, with no tag: the release before the one running, and the record forgets the undone one.
    def test_rollback_by_hand(self):
        run, calls, record = self.run_script("rollback", [self.OLDER, self.OLD, self.NEW])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn(f"render worktree {self.OLD}", calls)
        self.assertNotIn("migrate", calls)
        self.assertIn("login-roles", calls)  # a rotated password stays rotated (R7)
        self.assertEqual(record["history"], f"{self.OLDER} {self.OLD}")
        worktrees = subprocess.run(["git", "-C", str(REPO), "worktree", "list"], capture_output=True, text=True)
        self.assertNotIn("/tmp", worktrees.stdout)



# OPS-1-o-w: the login roles from the opened env files, read by compose as the
# services read them; each password reaches psql on stdin, never in an argv.
@unittest.skipUnless(shutil.which("docker"), "needs docker compose")
class LoginRolesTest(unittest.TestCase):
    PASSWORDS = {"DB_APP_PASSWORD": "it's\\x", "DB_CROSS_TENANT_PASSWORD": "cross-pw-1", "DB_AI_READER_PASSWORD": "ai-pw-1"}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        kubectl = self.state / "kubectl"
        kubectl.write_text(FAKE_KUBECTL)
        kubectl.chmod(0o755)
        (self.state / "opened").mkdir()
        (self.state / "opened/.env").write_text("DOMAIN_NAME=example.test\n")

    def tearDown(self):
        self.tmp.cleanup()

    def login_roles(self, passwords):
        (self.state / "opened/.env.prod").write_text("".join(f"{k}={v}\n" for k, v in passwords.items()))
        script = f'source "{REPO}/scripts/prod.k8s.sh"\nOPENED="{self.state}/opened"\nlogin_roles'
        run = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                             env={**os.environ, "FAKE_STATE": str(self.state), "KUBECTL": str(self.state / "kubectl"),
                                  "IMAGE_TAG": "t1"})
        calls = (self.state / "calls").read_text() if (self.state / "calls").exists() else ""
        stdin = (self.state / "exec-stdin").read_text() if (self.state / "exec-stdin").exists() else ""
        return run, calls, stdin

    def test_each_password_reaches_psql_on_stdin(self):
        run, calls, stdin = self.login_roles(self.PASSWORDS)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(calls.startswith("-n txnet exec -i statefulset/main-db -c main-db -- sh -c"), calls)
        for value in self.PASSWORDS.values():
            self.assertNotIn(value, calls)
        self.assertIn("\\set app_pw 'it''s\\\\x'\n", stdin)
        self.assertIn("\\set ai_pw 'ai-pw-1'\n", stdin)
        self.assertIn("ALTER ROLE txnet_app_user          PASSWORD :'app_pw';", stdin)

    def test_a_blank_password_is_named_and_nothing_runs(self):
        run, calls, _ = self.login_roles({**self.PASSWORDS, "DB_AI_READER_PASSWORD": ""})
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("DB_AI_READER_PASSWORD", run.stderr)
        self.assertNotIn("exec", calls)


if __name__ == "__main__":
    unittest.main()
