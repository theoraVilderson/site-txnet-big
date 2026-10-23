"""The two servers of a move: this one, and the new one reached over ssh (OPS-1-ac, H23)."""
import hashlib
import json
import os
import shlex
import subprocess

import move_figures as mf

SSH = ["ssh", "-o", "BatchMode=yes"]
VOLUME_LABEL_PROJECT = "com.docker.compose.project"


class Host:
    """Runs commands in the same repo path on this server, or on `ssh` when given."""

    def __init__(self, root, stack, ssh=None):
        self.root, self.stack, self.ssh = root, stack, ssh
        self.name = ssh or "this server"
        self._docker_root = None

    def run(self, argv, stdin=None):
        """stdout of argv; a failure raises with the command's own stderr."""
        wire = SSH + [self.ssh, shlex.join(argv)] if self.ssh else argv
        done = subprocess.run(wire, input=stdin, capture_output=True, text=True)
        if done.returncode != 0:
            what = " ".join(os.path.basename(word) for word in argv[:3])
            raise RuntimeError("%s: `%s …` failed: %s" % (self.name, what, done.stderr.strip()))
        return done.stdout

    def sh(self, script, *args):
        return self.run(["sh", "-c", script, "_", *args])

    def compose(self, *args, stdin=None):
        """The stack's own wrapper, so the move sees exactly what an operator would."""
        return self.run([self.wrapper(), *args], stdin=stdin)

    def compose_past_guard(self, *args):
        """compose for a rollback: passes moved-guard.sh on the server moved from."""
        return self.run(["env", "TXNET_MOVED_OK=1", self.wrapper(), *args])

    def wrapper(self):
        return os.path.join(self.root, "scripts", self.stack + ".compose.sh")

    def config(self):
        return json.loads(self.compose("config", "--format", "json"))

    def address(self, path):
        """path as rsync names it from this server."""
        return "%s:%s" % (self.ssh, path) if self.ssh else path

    def docker_root(self):
        if self._docker_root is None:
            self._docker_root = self.run(["docker", "info", "-f", "{{.DockerRootDir}}"]).strip()
        return self._docker_root

    def volume_dir(self, name):
        return os.path.join(self.docker_root(), "volumes", name, "_data") + "/"

    def volume_labels(self, name):
        """The volume's labels, or None when it does not exist."""
        try:
            return json.loads(self.run(["docker", "volume", "inspect", "-f", "{{json .Labels}}", name])) or {}
        except RuntimeError:
            return None

    def ensure_volume(self, name, labels):
        """Create name with labels unless it exists. Compose's own labels, so
        compose adopts the volume instead of warning it was made elsewhere."""
        if self.volume_labels(name) is None:
            flags = [arg for key, value in sorted(labels.items()) for arg in ("--label", "%s=%s" % (key, value))]
            self.run(["docker", "volume", "create", *flags, name])

    def project_volumes(self, project):
        out = self.run(["docker", "volume", "ls", "-q", "--filter", "label=%s=%s" % (VOLUME_LABEL_PROJECT, project)])
        return out.split()

    def digest(self, path):
        """sha256 of every file's content under path."""
        return hashlib.sha256(self.sh(mf.CONTENT_LISTING_SHELL, path).encode()).hexdigest()

    def metadata_digest(self, path):
        """sha256 of every file's name, size and mtime under path."""
        return hashlib.sha256(self.sh(mf.METADATA_LISTING_SHELL, path).encode()).hexdigest()

    def free_bytes(self, path):
        return int(self.run(["df", "--output=avail", "-B1", path]).split()[-1])

    def used_bytes(self, path):
        return int(self.run(["du", "-sb", path]).split()[0])


def live_figures(host, redis_password):
    """Row counts, Redis keys and queued messages, read through the data services."""
    sql = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"'
    figures = mf.parse_counts(host.compose("exec", "-T", "main-db", "sh", "-c", sql, "_", mf.TABLE_COUNTS_SQL))
    # the password goes over stdin, never onto a command line ps can read (C-32)
    redis = 'read -r pw; REDISCLI_AUTH="$pw" redis-cli info keyspace'
    figures.update(mf.parse_keyspace(host.compose("exec", "-T", "memory-data", "sh", "-c", redis, stdin=redis_password + "\n")))
    queues = host.compose("exec", "-T", "rabbitmq", "rabbitmqctl", "list_queues", "-q", "--no-table-headers", "messages")
    figures.update(mf.parse_queues(queues))
    return figures


def redis_password(config):
    """--requirepass from memory-data's resolved command."""
    command = config["services"]["memory-data"]["command"]
    words = command if isinstance(command, list) else shlex.split(command)
    return words[words.index("--requirepass") + 1]
