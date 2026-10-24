"""Where a bundle is made and restored: the compose stack here, or Kubernetes (bundle_k8s.py).

Both answer the same questions — run this in that service, a throwaway
container of that image, a volume packed or unpacked, the platform stopped or
started — so bundle_make and bundle_restore never ask which (OPS-1-o-k).
"""
import contextlib
import os
import secrets
import subprocess

import bundle_io as bio
import bundle_plan as bp
import move_hosts as mh
import move_plan as mp

K8S = "k8s"
WAIT_TIMEOUT_S = "600"
# One image at a time, each attempt bounded: built together on the 2026-10-23
# fresh server, three `apk add`s hung on stalled connections (apk has no timeout).
BUILD_TIMEOUT_S = "600"
BUILD_ATTEMPTS = 3
# What a scratch container runs until it is exec'd into; TERM ends it at once.
IDLE = ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"]
PUT = 'mkdir -p "$(dirname "$1")" && cat > "$1" && wc -c < "$1"'
PUT_ATTEMPTS = 3


def open_stack(root, stack):
    """The stack a server runs: a compose wrapper's name, or `k8s`. Close it when done."""
    if stack == K8S:
        import bundle_k8s  # kubectl and the renderer, only where they are used
        return bundle_k8s.K8sStack(root)
    return ComposeStack(root, stack)


class Box:
    """A scratch container or pod: exec into it, put a file in it, read its log."""

    def __init__(self, host, exec_prefix, logs_argv):
        self.host, self.prefix, self.logs_argv = host, exec_prefix, logs_argv

    def exec_argv(self, *args):
        return self.prefix + list(args)

    def put(self, path, dest):
        """path's bytes at dest inside, its directory made first, and counted there.

        Counted, not trusted: `kubectl exec -i` into a command that ends at its
        input's end lost the tail of 5 MB in most runs (k3s 1.34, WebSockets and
        SPDY alike); with the count printed after, all 11 of 5 and 60 MB arrived."""
        expected = os.path.getsize(path)
        for _ in range(PUT_ATTEMPTS):
            got = self.host.run_from_file(self.exec_argv("sh", "-c", PUT, "_", dest), path).strip()
            if got == str(expected):
                return
        raise RuntimeError("%s reached %s as %s of %d bytes, %d times" % (path, dest, got, expected, PUT_ATTEMPTS))

    def logs(self):
        return self.host.run(self.logs_argv)


class ComposeStack(mh.Host):
    """The stack a scripts/<stack>.compose.sh wrapper runs on this server."""

    MIGRATE_HINT = "apply its migrations (CLAUDE.md 'Dev database migrations')"

    def close(self):
        pass

    def exec_argv(self, service, *args):
        return [self.wrapper(), "exec", "-T", service, *args]

    def service_box(self, service):
        """A running service as a Box, to put files in and run them there."""
        return Box(self, self.exec_argv(service), [self.wrapper(), "logs", service])

    def image(self, service):
        return self.config()["services"][service]["image"]

    def _volume(self, key):
        return (self.config().get("volumes") or {})[key].get("name", key)

    @contextlib.contextmanager
    def scratch(self, image, command=None, env=None, volume=None, host_dir=None, network=False):
        """A throwaway container, with no network unless asked; removed with its anonymous volumes
        (an image's VOLUME, as Postgres's and Redis's declare, would otherwise outlive it)."""
        name = "txnet-bundle-" + secrets.token_hex(4)
        command = command or IDLE
        argv = ["docker", "run", "-d", "--rm", "--name", name] + ([] if network else ["--network", "none"])
        if volume:
            argv += ["-v", "%s:/data" % self._volume(volume)]
        if host_dir:
            argv += ["-v", "%s:%s:ro" % host_dir]
        for pair in sorted((env or {}).items()):
            argv += ["-e", "%s=%s" % pair]
        self.run(argv + ["--entrypoint", command[0], image, *command[1:]])
        try:
            yield Box(self, ["docker", "exec", "-i", name], ["sh", "-c", 'docker logs "$1" 2>&1', "_", name])
        finally:
            subprocess.run(["docker", "rm", "-fv", name], capture_output=True)

    def pack_volume(self, key, archive):
        self.run(["tar", "-C", self.volume_dir(self._volume(key)), "--numeric-owner", "-cf", archive, "."])

    def unpack_volume(self, key, archive):
        self.empty_volume(key)
        self.run(["tar", "-C", self.volume_dir(self._volume(key)), "--numeric-owner", "-xpf", archive])

    def empty_volume(self, key):
        self.run(["find", self.volume_dir(self._volume(key)), "-mindepth", "1", "-delete"])

    @contextlib.contextmanager
    def management_url(self, port):
        """RabbitMQ's management API on its container address."""
        container = self.compose("ps", "-q", "rabbitmq").strip()
        address = self.run(["docker", "inspect", "-f",
                            "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container]).split()[0]
        yield "http://%s:%d/api/" % (address, port)

    def holds_data(self):
        return bp.holds_data(self.volume_dir(self._volume("postgres_data")))

    def prepare(self, say):
        """Every image the stack builds, one at a time, while this server still serves."""
        for service in sorted(name for name, spec in self.config()["services"].items() if spec.get("build")):
            for attempt in range(1, BUILD_ATTEMPTS + 1):
                try:
                    self.run(["timeout", BUILD_TIMEOUT_S, self.wrapper(), "build", "-q", service])
                    break
                except RuntimeError:
                    if attempt == BUILD_ATTEMPTS:
                        raise RuntimeError("%s did not build in %d attempts; nothing was stopped" % (service, BUILD_ATTEMPTS))
                    say("%s: build attempt %d failed or stalled; again", service, attempt)
        say("every image built")

    def stop_all(self):
        self.compose("up", "--no-start")
        self.compose("stop")

    def start_data(self):
        self.compose("up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_S, *mp.DATA_SERVICES)

    def start_all(self):
        self.compose("up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_S)

    def login_roles(self):
        self.run(["env", "ENV_FILE=.env." + self.stack, os.path.join(self.root, "scripts", "db-login-roles.sh")])

    def key_digest(self, path):
        return bio.path_digest(path if os.path.isabs(path) else os.path.join(self.root, path))

    def start_full_backup(self):
        self.compose("exec", "-d", "pg-backup", "sh", "/usr/local/bin/pg-backup.sh", "full")

    def has_service(self, service):
        return service in self.config()["services"]
