"""OPS-1-ac: a server move carries every byte of state, and proves it did.

Run: python3 -m unittest scripts/move/test_server_move.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import move_figures as mf  # noqa: E402
import move_hosts as mh  # noqa: E402
import move_plan as mp  # noqa: E402
import move_projects as mj  # noqa: E402
import server_move as sm  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def compose_config(volumes, binds=None):
    services = {
        name: {"volumes": [{"type": "bind", "source": src, "target": tgt} for src, tgt in pairs]}
        for name, pairs in (binds or {}).items()
    }
    return {"name": "devtxnet", "volumes": {k: {"name": "devtxnet_" + k} for k in volumes}, "services": services}


class PulledServices(unittest.TestCase):
    # Rehearsal 2026-10-31: pg-backup runs main-db's built txnet/postgres:18, has
    # no build: of its own, and `pull --ignore-buildable` asked Docker Hub for it.
    def test_an_image_another_service_builds_is_not_pulled(self):
        config = {"services": {
            "main-db": {"image": "txnet/postgres:18", "build": {"context": "./postgres"}},
            "pg-backup": {"image": "txnet/postgres:18"},
            "auth-service": {"build": {"context": "../txnet-backend"}},
            "rabbitmq": {"image": "mirror.example/rabbitmq:4.2"},
        }}
        self.assertEqual(mp.pulled_services(config), ["rabbitmq"])


def bind(source, target):
    return {"type": "bind", "source": source, "target": target}


class NodeTrees(unittest.TestCase):
    # Rehearsal 2026-10-31: dev's Nest services and site-pwa run on the host
    # checkout's node_modules, which git does not hold; on the new server every
    # one of them failed "Cannot find module 'webpack'".
    def config(self, root):
        node = "mirror.example/node:24-bookworm"
        return {"services": {
            "auth-service": {"image": node, "volumes": [bind(f"{root}/txnet-backend", "/app")]},
            "bot-service": {"image": node, "volumes": [bind(f"{root}/txnet-backend", "/app")]},
            "site-pwa": {"image": "dev_site-pwa", "build": {"context": "../site-pwa"}, "volumes": [
                bind(f"{root}/site-pwa", "/app"), bind(f"{root}/site-pwa/node_modules", "/app/node_modules")]},
            "coinsite": {"image": "dev_coinsite", "build": {"context": "../coinsite"}, "volumes": [
                bind(f"{root}/coinsite", "/app"), {"type": "volume", "target": "/app/node_modules"}]},
            "main-db": {"image": "txnet/postgres:18", "volumes": [bind("/var/lib/x", "/var/lib/postgresql")]},
            "locale-service": {"build": {"context": "../i18n-platform"}, "volumes": [bind(f"{root}/locales", "/locales")]},
        }}

    def test_a_tree_running_on_the_host_s_node_modules_is_installed_in_its_own_image(self):
        trees = mp.node_trees(self.config("/r"), "/r")
        self.assertEqual(trees, [("site-pwa", "dev_site-pwa", "/app"),
                                 ("txnet-backend", "mirror.example/node:24-bookworm", "/app")])

    def test_a_tree_whose_node_modules_the_image_keeps_is_not(self):
        self.assertNotIn("coinsite", [t for t, _, _ in mp.node_trees(self.config("/r"), "/r")])

    def test_prisma_is_generated_only_where_the_package_names_a_schema(self):
        self.assertEqual(mp.install_script({"prisma": {"schema": "prisma/domains"}}), "npm ci && npx prisma generate")
        self.assertEqual(mp.install_script({"name": "site-pwa"}), "npm ci")


class NotReady(unittest.TestCase):
    # Rehearsal 2026-10-31: network-service's first `air` build on a server with no Go
    # cache outlasted its healthcheck; `up --wait` gave up on "unhealthy" a minute
    # before it listened. Not ready is waited on; only the timeout fails.
    def rows(self, **health):
        return [{"Service": s, "State": "running", "Health": h} for s, h in health.items()]

    def test_unhealthy_and_starting_are_not_ready_yet(self):
        rows = self.rows(api="healthy", net="unhealthy", web="starting", mail="")
        self.assertEqual(mp.not_ready(rows, ["api", "net", "web", "mail"]), ["net", "web"])

    def test_a_service_not_running_or_not_listed_is_not_ready(self):
        rows = [{"Service": "api", "State": "restarting", "Health": ""}]
        self.assertEqual(mp.not_ready(rows, ["api", "bot"]), ["api", "bot"])


class StateVolumes(unittest.TestCase):
    def test_state_is_moved_and_rebuildable_volumes_are_not(self):
        config = compose_config(["postgres_data", "pg_socket", "redis_vol_internal", "locale_cache"])
        self.assertEqual(
            mp.state_volumes(config),
            {"postgres_data": "devtxnet_postgres_data", "redis_vol_internal": "devtxnet_redis_vol_internal"},
        )

    def test_a_volume_nobody_classified_stops_the_move(self):
        with self.assertRaisesRegex(mp.PlanError, "uploads_v2"):
            mp.state_volumes(compose_config(["postgres_data", "uploads_v2"]))

    def test_the_repo_compose_files_declare_no_unclassified_volume(self):
        out = subprocess.run(
            [os.path.join(REPO, "scripts/dev.compose.sh"), "config", "--format", "json"],
            capture_output=True, text=True,
        )
        if out.returncode != 0:
            self.skipTest("compose config unavailable here")
        import json

        config = json.loads(out.stdout)
        moved = mp.state_volumes(config)
        self.assertIn("rabbitmq_data", moved)
        self.assertIn("object_storage", moved)
        # a node named after the container id leaves its queues behind on every recreate
        self.assertEqual(mp.rabbitmq_node(config), "rabbit@localhost")

    def test_backup_repositories_are_the_bind_sources_mounted_at_repo(self):
        config = compose_config([], {
            "pg-backup": [("/var/backups/txnet/pg", "/repo"), ("/var/lib/txnet/node-textfile", "/textfile")],
            "main-db": [("/var/backups/txnet/pg", "/repo")],
            "pg-backup-2": [("/srv/pg-repo-2", "/repo")],
        })
        self.assertEqual(mp.backup_dirs(config), ["/srv/pg-repo-2", "/var/backups/txnet/pg"])


class CarriedFiles(unittest.TestCase):
    def test_a_missing_key_is_named_before_anything_stops(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        os.makedirs(os.path.join(root, "dev-docker/secrets"))
        open(os.path.join(root, "dev-docker/secrets/vault-kek"), "w").close()
        missing = mp.missing_required(root)
        self.assertIn("dev-docker/secrets/pg-backup-passphrase", missing)
        self.assertNotIn("dev-docker/secrets/vault-kek", missing)

    def test_only_carried_paths_that_exist_are_sent(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        subprocess.run(["git", "init", "-q", root], check=True)
        open(os.path.join(root, ".env"), "w").close()
        self.assertEqual(mp.present_carried(root), [".env"])


class Rsync(unittest.TestCase):
    def test_a_volume_final_pass_compares_content_not_timestamps(self):
        # a Postgres page rewritten within the second of the presync keeps its
        # size and mtime; only a checksum pass sees it
        args = mp.checksum_rsync("/a/", "host:/a/")
        self.assertIn("--checksum", args)
        self.assertNotIn("--checksum", mp.quick_rsync("/a/", "host:/a/"))

    def test_both_passes_mirror_exactly_with_owners_by_number(self):
        for args in (mp.checksum_rsync("/a/", "h:/a/"), mp.quick_rsync("/a/", "h:/a/")):
            self.assertIn("--delete", args)
            self.assertIn("--numeric-ids", args)
            self.assertEqual(args[-2:], ["/a/", "h:/a/"])


class Figures(unittest.TestCase):
    def test_keyspace_splits_keys_that_expire_from_keys_that_do_not(self):
        info = "# Keyspace\r\ndb0:keys=120,expires=100,avg_ttl=5\r\ndb1:keys=5,expires=0,avg_ttl=0\r\n"
        self.assertEqual(mf.parse_keyspace(info), {"redis:persistent": 25, "redis:volatile": 100})

    def test_an_empty_keyspace_is_zero_not_missing(self):
        self.assertEqual(mf.parse_keyspace("# Keyspace\r\n"), {"redis:persistent": 0, "redis:volatile": 0})

    def test_table_counts_and_queue_totals(self):
        self.assertEqual(
            mf.parse_counts("identity.user|42\nbilling.wallet_transaction|7\n"),
            {"pg:identity.user": 42, "pg:billing.wallet_transaction": 7},
        )
        self.assertEqual(mf.parse_queues("0\n3\n\n2\n"), {"mq:messages": 5})

    def test_identical_figures_pass(self):
        figures = {"pg:identity.user": 42, "redis:persistent": 3, "bytes:postgres_data": "ab"}
        self.assertEqual(mf.compare(figures, dict(figures)), [])

    def test_a_lost_row_or_a_flushed_redis_fails(self):
        source = {"pg:identity.user": 42, "redis:persistent": 30, "redis:volatile": 900}
        target = {"pg:identity.user": 41, "redis:persistent": 30, "redis:volatile": 0}
        problems = mf.compare(source, target)
        self.assertEqual(len(problems), 2)
        self.assertTrue(any("pg:identity.user" in p for p in problems))
        self.assertTrue(any("redis:volatile" in p for p in problems))

    def test_keys_that_expired_during_the_move_are_not_a_loss(self):
        # captcha and rate-limit keys live 60s; the move takes minutes
        source = {"redis:volatile": 900, "mq:messages": 4}
        self.assertEqual(mf.compare(source, {"redis:volatile": 870, "mq:messages": 3}), [])

    def test_more_on_the_target_than_the_source_is_a_second_writer(self):
        problems = mf.compare({"redis:volatile": 900}, {"redis:volatile": 950})
        self.assertEqual(len(problems), 1)

    def test_bytes_must_match_exactly_and_a_missing_figure_fails(self):
        problems = mf.compare({"bytes:object_storage": "aa", "pg:x.y": 1}, {"bytes:object_storage": "bb"})
        self.assertEqual(len(problems), 2)


class Listings(unittest.TestCase):
    """The digests run on a real directory: a symlink to a directory is pgBackRest's `latest`."""

    def setUp(self):
        self.tree = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tree)
        os.makedirs(os.path.join(self.tree, "backup/set1"))
        with open(os.path.join(self.tree, "backup/set1/page"), "w") as f:
            f.write("one")
        os.symlink("set1", os.path.join(self.tree, "backup/latest"))
        self.host = mh.Host(self.tree, "dev")

    def test_a_symlinked_directory_is_listed_by_its_target(self):
        listing = self.host.sh(mf.CONTENT_LISTING_SHELL, self.tree)
        self.assertIn("./backup/latest -> set1", listing)

    def test_content_is_seen_by_the_content_digest_only(self):
        content, metadata = self.host.digest(self.tree), self.host.metadata_digest(self.tree)
        page = os.path.join(self.tree, "backup/set1/page")
        stat = os.stat(page)
        with open(page, "w") as f:
            f.write("two")  # same size
        os.utime(page, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertNotEqual(self.host.digest(self.tree), content)
        self.assertEqual(self.host.metadata_digest(self.tree), metadata)

    def test_an_unreadable_file_fails_the_digest_instead_of_dropping_out(self):
        if os.geteuid() == 0:
            self.skipTest("root reads every file")
        os.chmod(os.path.join(self.tree, "backup/set1/page"), 0)
        with self.assertRaises(RuntimeError):
            self.host.digest(self.tree)


class ComposeWrapper(unittest.TestCase):
    """The old server, once moved from, refuses to start the stack again."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        subprocess.run(["git", "init", "-q", self.root], check=True)  # a move runs from a checkout
        os.makedirs(os.path.join(self.root, "scripts"))
        os.makedirs(os.path.join(self.root, "bin"))
        for script in ("dev.compose.sh", "moved-guard.sh"):
            shutil.copy(os.path.join(REPO, "scripts", script), os.path.join(self.root, "scripts"))
        fake = os.path.join(self.root, "bin/docker")
        with open(fake, "w") as f:
            f.write("#!/bin/sh\necho docker-ran\n")
        os.chmod(fake, 0o755)

    def run_wrapper(self, *args, **env):
        return subprocess.run(
            [os.path.join(self.root, "scripts/dev.compose.sh"), *args],
            capture_output=True, text=True,
            env={**os.environ, "PATH": os.path.join(self.root, "bin") + ":" + os.environ["PATH"], **env},
        )

    def test_up_is_refused_after_a_move(self):
        with open(os.path.join(self.root, mp.MOVED_MARKER), "w") as f:
            f.write("root@203.0.113.7 2026-10-23T12:00:00Z\n")
        out = self.run_wrapper("up", "-d")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("203.0.113.7", out.stderr)
        self.assertNotIn("docker-ran", out.stdout)

    def test_reading_commands_still_work_after_a_move(self):
        open(os.path.join(self.root, mp.MOVED_MARKER), "w").close()
        self.assertIn("docker-ran", self.run_wrapper("ps").stdout)

    def test_without_a_move_up_runs(self):
        self.assertIn("docker-ran", self.run_wrapper("up", "-d").stdout)


CONFIG = {
    "name": "devtxnet",
    "volumes": {"postgres_data": {"name": "devtxnet_postgres_data"}},
    "services": {
        "rabbitmq": {"environment": {"RABBITMQ_NODENAME": "rabbit@localhost"}},
        "memory-data": {"command": ["sh", "-c", 'redis-server --requirepass "$REDIS_PASSWORD"'],
                        "environment": {"REDIS_PASSWORD": "pw"}},
    },
}
RUNNING = ["main-db", "memory-data", "rabbitmq", "auth-service", "gateway-handler"]
FIGURES = {"pg:identity.user": 42, "redis:persistent": 3, "redis:volatile": 10, "mq:messages": 1}


class FakeHost:
    """Records what the move asks a server to do, in one log both sides share."""

    stack = "dev"

    def __init__(self, root, log, name, figures, digest="same", project_ids="", missing=()):
        self.root, self.log, self.ssh, self.name = root, log, name, name
        self.figures, self.digest_value, self.project_ids = figures, digest, project_ids
        self.missing = set(missing)

    def config(self):
        return CONFIG

    def compose(self, *args, stdin=None):
        self.log.append((self.name,) + args)
        if args[:2] == ("ps", "--services"):
            return "\n".join(RUNNING)
        if args[:3] == ("exec", "-T", "main-db"):
            return "off"  # archive_mode: the WAL flush is H1's, not this test's
        if args[:3] == ("ps", "--format", "json"):
            return "\n".join(json.dumps({"Service": s, "State": "running", "Health": "healthy"}) for s in RUNNING)
        return ""

    def run(self, argv, stdin=None):
        self.log.append((self.name, "run") + tuple(argv))
        if argv[:3] == ["docker", "ps", "-aq"]:
            return self.project_ids
        if argv[:2] == ["docker", "inspect"] and "{{.Config.Image}}" in argv:
            return "\n".join(PANEL_IMAGES)
        if argv[:2] == ["docker", "inspect"]:
            return json.dumps(LABELS)
        if argv[:3] == ["docker", "image", "inspect"] and argv[3] in self.missing:
            raise RuntimeError("%s: No such image: %s" % (self.name, argv[3]))
        return ""

    def project_volumes(self, project):
        return []

    def sh(self, script, *args):
        return ""

    def address(self, path):
        return "%s:%s" % (self.name, path)

    def volume_dir(self, name):
        return "/vol/%s/" % name

    def volume_labels(self, name):
        return {}

    def ensure_volume(self, name, labels):
        pass

    def digest(self, path):
        return self.digest_value

    def metadata_digest(self, path):
        return "same"


class Cutover(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        subprocess.run(["git", "init", "-q", self.root], check=True)  # a move runs from a checkout
        self.log = []
        # the preflight and the commands behind each figure are exercised on a
        # real stack by `check`; here only the order of the steps is under test
        for target, name, fake in (
            (sm.Move, "check", lambda move: []),
            (sm.Move, "rsync", lambda move, argv, stdin=None: self.log.append(("rsync",))),
            (mh, "live_figures", lambda host, password: dict(host.figures)),
        ):
            patcher = mock.patch.object(target, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def move(self, there_figures=FIGURES, there_digest="same", projects=None, project_ids="", missing=()):
        here = FakeHost(self.root, self.log, "here", FIGURES, project_ids=project_ids)
        there = FakeHost(self.root, self.log, "new", there_figures, there_digest, project_ids=project_ids,
                         missing=missing)
        return sm.Move(here, there, projects)

    # Rehearsal 2 (2026-10-31): paneltest's images are local builds and tags
    # (devtxnet-routeros-chr, marznode:pinned) and ghcr.io ones; `up` there pulled and failed.
    def test_a_side_project_s_images_the_new_server_lacks_are_copied_not_pulled(self):
        move = self.move(projects=["paneltest"], project_ids="abc123", missing=["local/chr:latest"])
        copied = []
        with mock.patch.object(mj.Projects, "copy_image", lambda p, there, image: copied.append(image)):
            move.projects.copy_images(move.there)
        self.assertEqual(copied, ["local/chr:latest"])

    # Rehearsal 2 (2026-10-31): the twin opens the sealed secrets with sops; the new
    # host had none, so `prod.k8s.sh install-tools` ran there by hand.
    def test_a_build_host_s_tools_are_installed_there_at_their_pins(self):
        move = self.move()
        with mock.patch.object(sm.os.path, "exists", lambda path: path == sm.BUILD_TOOL):
            move.install_build_tools()
        self.assertIn(("new", "run", os.path.join(self.root, "scripts", "prod.k8s.sh"), "install-tools"), self.log)

    def test_a_server_that_builds_nothing_gets_no_tools(self):
        move = self.move()
        with mock.patch.object(sm.os.path, "exists", lambda path: False):
            move.install_build_tools()
        self.assertFalse([e for e in self.log if "install-tools" in e])

    def test_rollback_stops_the_side_projects_on_the_new_server_too(self):
        move = self.move(projects=["paneltest"], project_ids="abc123")
        move.cutover()
        move.rollback()
        self.assertIn(("new", "run", "docker", "stop", "abc123"), self.log)

    # The command is saved before the project stops: stopped, nothing names how it ran.
    def test_a_side_project_stops_here_and_starts_there_and_back_on_rollback(self):
        move = self.move(projects=["paneltest"], project_ids="abc123")
        move.cutover()
        up = ("run",) + tuple(mj.up_command("paneltest", LABELS))
        self.assertIn(("here", "run", "docker", "stop", "abc123"), self.log)
        self.assertIn(("new",) + up, self.log)
        move.rollback()
        self.assertIn(("here",) + up, self.log)

    def index(self, *entry):
        return self.log.index(entry)

    def marker(self):
        return os.path.join(self.root, mp.MOVED_MARKER)

    def test_writers_stop_before_the_figures_and_the_data_services_after(self):
        self.move().cutover()
        stop_apps = self.index("here", "stop", "auth-service", "gateway-handler")
        stop_data = self.index("here", "stop", *mp.DATA_SERVICES)
        self.assertLess(stop_apps, stop_data)
        self.assertLess(stop_data, self.log.index(("rsync",)))

    def test_the_new_server_starts_its_data_before_its_services_and_this_one_is_fenced(self):
        self.move().cutover()
        wait = ("--wait", "--wait-timeout", sm.WAIT_TIMEOUT_S)
        start_data = self.index("new", "up", "-d", *wait, *mp.DATA_SERVICES)
        self.assertLess(start_data, self.index("new", "up", "-d", *RUNNING))
        self.assertLess(self.index("new", "up", "-d", *RUNNING), self.index("new", "ps", "--format", "json"))
        with open(self.marker()) as f:
            self.assertIn("new", f.read())

    def test_a_copy_whose_bytes_differ_is_never_started_and_this_server_is_not_fenced(self):
        with self.assertRaises(sm.Abort):
            self.move(there_digest="other").cutover()
        self.assertFalse(any(e[:2] == ("new", "up") for e in self.log))
        self.assertFalse(os.path.exists(self.marker()))

    def test_a_flushed_redis_on_the_new_server_stops_before_its_services_start(self):
        with self.assertRaises(sm.Abort):
            self.move(there_figures={**FIGURES, "redis:volatile": 0}).cutover()
        self.assertEqual([e for e in self.log if e[:2] == ("new", "up")][-1][-3:], mp.DATA_SERVICES)

    def test_rollback_stops_the_new_server_then_starts_what_ran_here(self):
        with self.assertRaises(sm.Abort):
            self.move(there_figures={**FIGURES, "pg:identity.user": 41}).cutover()
        self.log.clear()
        self.move().rollback()
        self.assertLess(self.index("new", "stop"), self.index("here", "start", *RUNNING))
        self.assertFalse(os.path.exists(self.marker()))


PANEL_IMAGES = ["local/chr:latest", "mirror.example/marzban:v0.8.4", "local/chr:latest"]
LABELS = {"com.docker.compose.project.working_dir": "/root/paneltest",
          "com.docker.compose.project.config_files": "/root/paneltest/compose.yml",
          "com.docker.compose.project.environment_file": ""}


class Projects(unittest.TestCase):
    # Rehearsal 2026-10-31: the twin joins paneltest's panels, and the move left them behind.
    def test_a_project_starts_there_as_it_was_started_here(self):
        self.assertEqual(mj.up_command("paneltest", LABELS),
                         ["docker", "compose", "-p", "paneltest", "--project-directory", "/root/paneltest",
                          "-f", "/root/paneltest/compose.yml", "up", "-d"])

    def test_a_project_outside_the_checkout_moves_its_directory(self):
        self.assertEqual(mj.outside_dir(LABELS, "/root/site-txnet-big"), "/root/paneltest/")
        inside = {**LABELS, "com.docker.compose.project.working_dir": "/root/site-txnet-big/dev-docker/monitoring"}
        self.assertIsNone(mj.outside_dir(inside, "/root/site-txnet-big"))


class SecretFiles(unittest.TestCase):
    # Rehearsal 2 (2026-10-31): platform-owner-password, object-backup-password,
    # arvan-s3.env and arvan/ were added after CARRIED_FILES was written, and stayed.
    def test_every_file_git_ignores_under_secrets_is_carried(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        secrets = os.path.join(root, mp.SECRETS_DIR)
        os.makedirs(os.path.join(secrets, "arvan"))
        for name, text in ((".gitignore", "*\n!.gitignore\n!README.md\n"), ("README.md", "x"),
                           ("platform-owner-password", "x"), ("arvan/key", "x")):
            with open(os.path.join(secrets, name), "w") as f:
                f.write(text)
        subprocess.run(["git", "init", "-q", root], check=True)
        subprocess.run(["git", "-C", root, "add", "."], check=True)
        self.assertEqual(mp.ignored_secrets(root), [mp.SECRETS_DIR + "/arvan/key",
                                                    mp.SECRETS_DIR + "/platform-owner-password"])
        self.assertIn(mp.SECRETS_DIR + "/platform-owner-password", mp.present_carried(root))


class BuildHostFiles(unittest.TestCase):
    # Rehearsal 2026-10-31: the twin reads production's bundle over ssh and `push`
    # logs in to the registry; neither key is in the checkout, so neither moved.
    def test_the_release_s_keys_move_with_the_build_host(self):
        files = mp.build_host_files({"STAGING_PROD_SSH_KEY": "/root/.ssh/prod_key"}, "/root")
        self.assertEqual(files, ["/root/.docker/config.json", "/root/.ssh/known_hosts",
                                 "/root/.ssh/prod_key", "/root/.ssh/prod_key.pub"])

    def test_a_server_that_releases_nothing_carries_only_its_logins(self):
        self.assertEqual(mp.build_host_files({}, "/root"), ["/root/.docker/config.json", "/root/.ssh/known_hosts"])


if __name__ == "__main__":
    unittest.main()
