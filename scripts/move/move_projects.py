"""Compose projects that move beside the stack (hosting H23): monitoring, paneltest.

Each is stopped here, its every volume and (outside the checkout) its directory
copied, and started there with the `compose up` its own labels record.
"""
import json
import os
import subprocess

import move_hosts as mh

WORKING_DIR = "com.docker.compose.project.working_dir"
CONFIG_FILES = "com.docker.compose.project.config_files"
ENV_FILES = "com.docker.compose.project.environment_file"


def up_command(project, labels):
    """The `compose up` that started `project`, rebuilt from one of its containers' labels."""
    argv = ["docker", "compose", "-p", project, "--project-directory", labels[WORKING_DIR]]
    argv += [a for f in labels[CONFIG_FILES].split(",") for a in ("-f", f)]
    argv += [a for f in labels.get(ENV_FILES, "").split(",") if f for a in ("--env-file", f)]
    return argv + ["up", "-d"]


def outside_dir(labels, root):
    """The project's directory when git does not carry it (paneltest), else None."""
    working = os.path.realpath(labels[WORKING_DIR])
    inside = working == root or working.startswith(root.rstrip("/") + "/")
    return None if inside else working.rstrip("/") + "/"


class Projects:
    """The projects named on the command line, as this server runs them."""

    def __init__(self, here, names):
        self.here, self.names = here, list(names)

    def containers(self, name, *filters):
        label = "label=%s=%s" % (mh.VOLUME_LABEL_PROJECT, name)
        return self.here.run(["docker", "ps", "-aq", "--filter", label, *filters]).split()

    def labels(self, name):
        ids = self.containers(name)
        if not ids:
            return None
        return json.loads(self.here.run(["docker", "inspect", "-f", "{{json .Config.Labels}}", ids[0]]))

    def volumes(self):
        """Every volume of every project: a side project's volumes are all its state."""
        return [v for name in self.names for v in self.here.project_volumes(name)]

    def dirs(self, root):
        found = [outside_dir(labels, root) for labels in map(self.labels, self.names) if labels]
        return [d for d in found if d]

    def images(self):
        """Every image the projects' containers run, once each."""
        ids = [c for name in self.names for c in self.containers(name)]
        if not ids:
            return []
        return sorted(set(self.here.run(["docker", "inspect", "-f", "{{.Config.Image}}", *ids]).split()))

    def copy_images(self, there):
        """The images `there` lacks, copied rather than pulled: paneltest runs local builds
        and tags (routeros-chr, marznode:pinned) and ghcr.io images."""
        for image in self.images():
            try:
                there.run(["docker", "image", "inspect", image])
            except RuntimeError:
                self.copy_image(there, image)

    def copy_image(self, there, image):
        print("move: copying image %s to the new server" % image, flush=True)
        save = subprocess.Popen(["docker", "save", image], stdout=subprocess.PIPE)
        load = subprocess.run(mh.SSH + [there.ssh, "docker load"], stdin=save.stdout, capture_output=True, text=True)
        save.stdout.close()
        if save.wait() != 0 or load.returncode != 0:
            raise RuntimeError("could not copy image %s: %s" % (image, load.stderr.strip()))

    def up_commands(self):
        """The commands that start the projects running here now, for `there` or a rollback."""
        return [up_command(name, self.labels(name)) for name in self.names
                if self.containers(name, "--filter", "status=running")]

    def stop(self):
        running = [c for name in self.names for c in self.containers(name, "--filter", "status=running")]
        if running:
            self.here.run(["docker", "stop", *running])
