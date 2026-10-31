#!/usr/bin/env python3
"""Move the whole platform to another server, every byte of state (OPS-1-ac, hosting H23).

  check    --to root@new   what moves, and every reason it cannot yet
  presync  --to root@new   copy while the stack runs; repeat as often as useful
  cutover  --to root@new   stop cleanly, final pass, prove it, start on the new server
  rollback --to root@new   before the DNS switch only: stop the new one, start this one

Run as root on the server being left, from the repo root, with the same commit
checked out at the same path on the new one. Runbook:
docs/operations/runbook-move-server.md
"""
import argparse
import glob
import json
import os
import sys
import time

import move_figures as mf
import move_hosts as mh
import move_plan as mp
import move_projects as mj

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MOVE_DIR = ".move"
SERVICES_FILE = os.path.join(MOVE_DIR, "services.json")
PRESYNC_STAMP = os.path.join(MOVE_DIR, "presync-from")
# Redis keeps each expiry as an absolute instant, and sessions and JWTs are
# judged by the clock: two clocks this far apart already shift them.
MAX_CLOCK_SKEW_S = 5
# The data grows between the check and the cutover.
DISK_HEADROOM = 1.2
# archive_timeout is 60s (H1): one switched segment is out well inside this.
ARCHIVE_WAIT_S = 90
WAIT_TIMEOUT_S = "600"
READY_POLL_S = 5
# Byte digests are compared before the new server starts, live figures after its data services do.
BYTE_FIGURES = ("bytes:",)
LIVE_FIGURES = ("pg:", "redis:", "mq:")
PSQL = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"'
FREE_BYTES_SHELL = (
    'p="$1"; while [ ! -e "$p" ]; do p=$(dirname "$p"); done; df --output=avail -B1 "$p" | tail -1'
)


def say(message, *args):
    print("move: " + (message % args if args else message), flush=True)


class Abort(Exception):
    """Stops the move; the message says what state the two servers are in."""


class Move:
    """One move from `here` (this server) to `there` (a Host over ssh)."""

    def __init__(self, here, there, projects=None):
        self.here, self.there = here, there
        self.root = here.root
        self.config = here.config()
        self.projects = mj.Projects(here, projects or [])

    # -- what moves -------------------------------------------------------

    def volumes(self):
        """docker volume name -> its labels, for every volume holding state."""
        names = list(mp.state_volumes(self.config).values()) + self.projects.volumes()
        return {name: self.here.volume_labels(name) for name in names}

    def volume_pairs(self):
        """(path here, path there) for every state volume."""
        return [(self.here.volume_dir(n), self.there.volume_dir(n)) for n in self.volumes()]

    def repository_pairs(self):
        """(path here, path there) for every backup repository: the same path on both."""
        return [(d, d) for d in self.backup_dirs()]

    def project_pairs(self):
        """A side project's own directory where git does not carry it (paneltest): the same path."""
        return [(d, d) for d in self.projects.dirs(self.root)]

    def directories(self):
        return self.volume_pairs() + self.project_pairs() + self.repository_pairs()

    def here_dirs(self):
        """The directories directories() pairs, from this side alone (no ssh)."""
        return [self.here.volume_dir(n) for n in self.volumes()] + [d for d, _ in self.project_pairs()] + self.backup_dirs()

    def build_host_files(self):
        """mp.build_host_files that exist here: a server that releases nothing has none of the keys."""
        env_file = os.path.join(self.root, ".env." + self.here.stack)
        env = mp.env_values(open(env_file).read()) if os.path.isfile(env_file) else {}
        return [f for f in mp.build_host_files(env, os.path.expanduser("~")) if os.path.isfile(f)]

    def backup_dirs(self):
        return [d.rstrip("/") + "/" for d in mp.backup_dirs(self.config)]

    # -- check ------------------------------------------------------------

    def problems(self):
        """Every reason the move cannot start; [] when it can."""
        found = []
        if os.geteuid() != 0:
            found.append("run as root: docker volumes are read and written directly")
        found += ["missing here: %s" % p for p in mp.missing_required(self.root)]
        found += self.unmovable_queues()
        try:
            self.there.run(["true"])
        except RuntimeError as err:
            return found + ["cannot reach the new server over ssh: %s" % err]
        try:
            return found + self.mismatches() + self.occupied()
        except RuntimeError as err:
            return found + [str(err)]

    def unmovable_queues(self):
        """RabbitMQ keeps a node's queues under its name; one started before the
        name was fixed would leave them behind on this server."""
        wanted = mp.rabbitmq_node(self.config)
        actual = self.here.compose("exec", "-T", "rabbitmq", "sh", "-c", 'echo "$RABBITMQ_NODENAME"').strip()
        if actual == wanted:
            return []
        return ["rabbitmq runs as %r, not %r: recreate it once its queues are empty (runbook, step 0)" % (actual, wanted)]

    def mismatches(self):
        found = []
        for what, argv in (("commit", ["git", "-C", self.root, "rev-parse", "HEAD"]), ("architecture", ["uname", "-m"])):
            mine, theirs = self.here.run(argv).strip(), self.there.run(argv).strip()
            if mine != theirs:
                found.append("%s differs: %s here, %s there" % (what, mine, theirs))
        skew = abs(int(self.here.run(["date", "+%s"])) - int(self.there.run(["date", "+%s"])))
        if skew > MAX_CLOCK_SKEW_S:
            found.append("clocks differ by %ss: turn on NTP on both" % skew)
        return found

    def occupied(self):
        """The new server already runs this stack, or holds data this move did not put there."""
        found = []
        if self.there.sh('test -e "$1" && echo yes || true', os.path.join(self.root, mp.MOVED_MARKER)).strip():
            found.append("the new server carries %s: it was moved from once" % mp.MOVED_MARKER)
        # by label, not the wrapper: before the first presync the new server has no .env to run it with
        project = "label=%s=%s" % (mh.VOLUME_LABEL_PROJECT, self.config["name"])
        if self.there.run(["docker", "ps", "-q", "--filter", project]).strip():
            found.append("the stack is running on the new server: stop it first")
        stamped = self.there.sh('test -e "$1" && echo yes || true', os.path.join(self.root, PRESYNC_STAMP)).strip()
        for _, path in self.directories():
            if not stamped and self.there.sh('ls -A "$1" 2>/dev/null | head -1', path).strip():
                found.append("%s on the new server holds data no presync put there" % path)
        needed = sum(self.here.used_bytes(d) for d in self.here_dirs()) * DISK_HEADROOM
        free = int(self.there.sh(FREE_BYTES_SHELL, self.there.docker_root()))
        if free < needed:
            found.append("the new server has %d MB free, the move needs %d MB" % (free >> 20, int(needed) >> 20))
        return found

    def check(self):
        for here in self.here_dirs():
            say("moves %-60s %8d MB", here, self.here.used_bytes(here) >> 20)
        for path in mp.present_carried(self.root) + self.build_host_files():
            say("moves %s", path)
        problems = self.problems()
        for problem in problems:
            say("BLOCKED: %s", problem)
        return problems

    # -- copying ----------------------------------------------------------

    def rsync(self, argv, stdin=None):
        """argv from move_plan, run here, over ssh to the new server."""
        self.here.run(argv[:1] + ["-e", " ".join(mh.SSH)] + argv[1:], stdin=stdin)

    def copy_dirs(self, volume_form):
        """Every volume in the pass volume_form builds; repositories always quick (write-once)."""
        for name, labels in self.volumes().items():
            self.there.ensure_volume(name, labels)
        for pairs, form in ((self.volume_pairs(), volume_form), (self.project_pairs(), volume_form),
                            (self.repository_pairs(), mp.quick_rsync)):
            for here, there in pairs:
                self.there.run(["mkdir", "-p", there])
                self.rsync(form(here, self.there.address(there)))

    def copy_files(self):
        """The git-ignored files and this move's own state, at the same paths."""
        os.makedirs(os.path.join(self.root, MOVE_DIR), exist_ok=True)
        carried = mp.present_carried(self.root) + [MOVE_DIR + "/"]
        self.rsync(mp.files_rsync(self.root + "/", self.there.address(self.root + "/")), stdin="\n".join(carried) + "\n")
        outside = [f.lstrip("/") for f in self.build_host_files()]
        if outside:
            self.rsync(mp.files_rsync("/", self.there.address("/")), stdin="\n".join(outside) + "\n")

    def presync(self):
        self.refuse_if_blocked()
        self.there.sh('mkdir -p "$(dirname "$1")" && date -u > "$1"', os.path.join(self.root, PRESYNC_STAMP))
        self.copy_files()
        say("building and pulling the images on the new server, so the cutover does not wait for them")
        self.there.compose("build")
        pulled = mp.pulled_services(self.config)
        if pulled:  # `compose pull` with no names pulls every service
            self.there.compose("pull", "--quiet", *pulled)
        self.install_node_trees()
        self.copy_dirs(mp.quick_rsync)
        say("presync done; the stack is still serving here. Repeat it, or run cutover.")

    def node_trees(self):
        """mp.node_trees with a package.json here: the trees whose node_modules npm installs."""
        return [(tree, image, target) for tree, image, target in mp.node_trees(self.config, self.root)
                if os.path.isfile(os.path.join(self.root, tree, "package.json"))]

    def install_node_trees(self):
        """npm ci on the new server inside the image the tree runs in, so native modules
        (Prisma's engine, swc) are built for that runtime, not for whatever Node is there."""
        for tree, image, target in self.node_trees():
            with open(os.path.join(self.root, tree, "package.json")) as f:
                script = mp.install_script(json.load(f))
            say("installing %s's node_modules on the new server (%s)", tree, script)
            self.there.run(["docker", "run", "--rm", "-v", "%s:%s" % (os.path.join(self.root, tree), target),
                            "-w", target, image, "sh", "-c", script])

    def uninstalled_trees(self):
        return [tree for tree, _, _ in self.node_trees()
                if self.there.sh('[ -d "$1" ] || echo missing', os.path.join(self.root, tree, "node_modules")).strip()]

    def refuse_if_blocked(self):
        problems = self.check()
        if problems:
            raise Abort("nothing was stopped or copied")

    # -- cutover ----------------------------------------------------------

    def cutover(self):
        self.refuse_if_blocked()
        running = self.here.compose("ps", "--services", "--status", "running").split()
        absent = [s for s in mp.DATA_SERVICES if s not in running]
        if absent:
            raise Abort("%s not running here: nothing to read the figures from; nothing was stopped" % ", ".join(absent))
        uninstalled = self.uninstalled_trees()
        if uninstalled:
            raise Abort("no node_modules on the new server for %s: run presync; nothing was stopped" % ", ".join(uninstalled))
        self.save_services(running)
        source = self.stop_here(running)
        self.copy_dirs(mp.checksum_rsync)
        self.copy_files()
        self.gate(source, self.digests(self.there), BYTE_FIGURES)
        with open(os.path.join(self.root, mp.MOVED_MARKER), "w") as marker:
            marker.write("%s %s\n" % (self.there.ssh, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
        self.start_there(running, source)

    def save_services(self, running):
        os.makedirs(os.path.join(self.root, MOVE_DIR), exist_ok=True)
        with open(os.path.join(self.root, SERVICES_FILE), "w") as f:
            json.dump({"services": running, "projects": self.projects.up_commands()}, f, indent=1)

    def stop_here(self, running):
        """Stops writers, then the data services, cleanly; returns the figures at rest."""
        apps = [s for s in running if s not in mp.DATA_SERVICES]
        say("stopping %d services; the platform is down from here", len(apps))
        if apps:  # `compose stop` with no names stops everything, data services too
            self.here.compose("stop", *apps)
        self.flush_wal()
        figures = mh.live_figures(self.here, mh.redis_password(self.config))
        say("read %d tables, %d+%d Redis keys, %d queued messages", len([k for k in figures if k.startswith("pg:")]),
            figures["redis:persistent"], figures["redis:volatile"], figures["mq:messages"])
        self.here.compose("stop", *mp.DATA_SERVICES)
        self.projects.stop()
        figures.update(self.digests(self.here))
        return figures

    def flush_wal(self):
        """The last WAL segment into the archive, so the repository ends where the database does."""
        psql = self.psql_here
        if psql("show archive_mode") != "on":
            return
        segment = psql("select pg_walfile_name(pg_switch_wal())")
        deadline = time.monotonic() + ARCHIVE_WAIT_S
        while psql("select coalesce(last_archived_wal, '') from pg_stat_archiver") < segment:
            if time.monotonic() > deadline:
                raise Abort("WAL %s not archived in %ss (PgArchiveFailing?); run rollback to start this server again" % (segment, ARCHIVE_WAIT_S))
            time.sleep(2)

    def psql_here(self, query):
        return self.here.compose("exec", "-T", "main-db", "sh", "-c", PSQL, "_", query).strip()

    def digests(self, host):
        """One digest per directory, keyed by its path here so both sides compare:
        content for a volume, names and sizes for a write-once repository."""
        side = 1 if host is self.there else 0
        figures = {"bytes:" + pair[0]: host.digest(pair[side]) for pair in self.volume_pairs()}
        figures.update({"bytes:" + pair[0]: host.metadata_digest(pair[side]) for pair in self.repository_pairs()})
        return figures

    def gate(self, source, target, prefixes):
        """Stops the move unless target holds every figure of source under prefixes."""
        expected = {k: v for k, v in source.items() if k.startswith(prefixes)}
        problems = mf.compare(expected, target)
        for problem in problems:
            say("MISMATCH: %s", problem)
        if problems:
            raise Abort("the new server is not a whole copy and serves nothing; run rollback")
        say("%d figures match (%s)", len(expected), " ".join(prefixes))

    def start_there(self, running, source):
        data = list(mp.DATA_SERVICES)
        say("starting %s on the new server", ", ".join(data))
        self.there.compose("up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_S, *data)
        live = mh.live_figures(self.there, mh.redis_password(self.config))
        self.gate(source, live, LIVE_FIGURES)
        say("starting the other %d services on the new server", len(running) - len(data))
        self.there.compose("up", "-d", *running)
        self.wait_ready(running)
        for command in self.saved()["projects"]:
            self.there.run(command)
        if "pg-backup" in running:
            # a baseline taken on the new server, whatever the copied repository holds (runbook step 4)
            self.there.compose("exec", "-d", "pg-backup", "sh", "/usr/local/bin/pg-backup.sh", "full")
        say("done: the platform runs on %s. Now point Cloudflare at it (runbook, 'After').", self.there.ssh)

    def wait_ready(self, services):
        """Every service running healthy within WAIT_TIMEOUT_S. Not `up --wait`: it gives up on
        the first "unhealthy", and a dev service's first build on a cold server (air, webpack)
        outlasts its healthcheck, then turns healthy."""
        deadline = time.monotonic() + int(WAIT_TIMEOUT_S)
        while True:
            rows = [json.loads(line) for line in self.there.compose("ps", "--format", "json").splitlines() if line]
            waiting = mp.not_ready(rows, services)
            if not waiting:
                return
            if time.monotonic() > deadline:
                raise Abort("not healthy after %ss on the new server: %s" % (WAIT_TIMEOUT_S, ", ".join(waiting)))
            time.sleep(READY_POLL_S)

    def saved(self):
        with open(os.path.join(self.root, SERVICES_FILE)) as f:
            return json.load(f)

    # -- rollback ---------------------------------------------------------

    def rollback(self):
        saved = self.saved()
        say("stopping the stack on %s", self.there.ssh)
        self.there.compose("stop")
        marker = os.path.join(self.root, mp.MOVED_MARKER)
        if os.path.exists(marker):
            os.remove(marker)
        say("starting %d services here", len(saved["services"]))
        self.here.compose("start", *saved["services"])
        for command in saved.get("projects", []):
            self.here.run(command)
        say("rolled back: this server serves again. Anything written on the new one since the cutover is not here.")


def main(argv=None):
    stacks = sorted(os.path.basename(p)[: -len(".compose.sh")] for p in glob.glob(os.path.join(ROOT, "scripts", "*.compose.sh")))
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["check", "presync", "cutover", "rollback"])
    parser.add_argument("--to", required=True, help="the new server, as ssh reaches it: root@203.0.113.7")
    parser.add_argument("--stack", choices=stacks, required=True, help="the compose wrapper this server runs")
    parser.add_argument("--monitor-project", help="the monitoring stack's compose project, to move its history too")
    parser.add_argument("--with-project", action="append", default=[],
                        help="another compose project that moves beside the stack, all its volumes (paneltest)")
    args = parser.parse_args(argv)
    projects = ([args.monitor_project] if args.monitor_project else []) + args.with_project
    move = Move(mh.Host(ROOT, args.stack), mh.Host(ROOT, args.stack, ssh=args.to), projects)
    try:
        if args.command == "check":
            return 1 if move.check() else 0
        getattr(move, args.command)()
    except (Abort, mp.PlanError, RuntimeError) as err:
        say("STOPPED: %s", err)
        if args.command == "cutover":
            say("this server may be stopped: `rollback` starts it again, whatever step failed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
