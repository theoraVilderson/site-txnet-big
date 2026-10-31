"""The two systemd timers: the nightly bundle and the ship every 10 minutes (OPS-1-ad).

Written from this checkout's path and stack, so the units never name a path
that is not there (scripts/dev-guard's units hardcode theirs). They follow the
platform (OPS-1-am-e): a restore installs them, and a move stops them on the
server it leaves and starts them on the one it opens.
"""
import os
import subprocess

UNIT_DIR = "/etc/systemd/system"
# 03:00 UTC: after pgBackRest (01:00) and restic (23:00), before the Sunday drill (06:00).
BUNDLE_AT = "*-*-* 03:00:00 UTC"
SHIP_EVERY = "10min"

_SERVICE = """[Unit]
Description={description} (OPS-1-ad, runbook-backup-bundle.md)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory={root}
ExecStart=/usr/bin/python3 {root}/scripts/bundle/{script} --stack {stack}
# below the live site and the bot, which share this host
Nice=10
IOSchedulingClass=idle
"""
_TIMER = """[Unit]
Description={description}

[Timer]
{schedule}
Persistent=true

[Install]
WantedBy=timers.target
"""
UNITS = {
    "txnet-backup": ("Make the nightly TXNet backup bundle", "backup.py now", "OnCalendar=" + BUNDLE_AT),
    "txnet-backup-ship": ("Send TXNet backup bundles to S3", "ship.py",
                          "OnBootSec=5min\nOnUnitActiveSec=" + SHIP_EVERY),
}

TIMERS = tuple(name + ".timer" for name in UNITS)
# Stops and disables whichever of TIMERS this server has; a server that never had them is not an error.
DISABLE_ARGV = ["sh", "-c", 'd=$1; shift; for t; do [ ! -e "$d/$t" ] || systemctl disable --now "$t" || exit 1; done',
                "_", UNIT_DIR, *TIMERS]


def install_argv(root, stack):
    """`install-timers` run from the checkout at root, as a move sends it to the other server."""
    return ["python3", os.path.join(root, "scripts/bundle/backup.py"), "--stack", stack, "install-timers"]


def inactive(is_active_output):
    """The timers `systemctl is-active <TIMERS>` did not answer `active` for."""
    answers = is_active_output.split()
    return [timer for i, timer in enumerate(TIMERS) if i >= len(answers) or answers[i] != "active"]


def present(unit_dir=UNIT_DIR):
    return any(os.path.exists(os.path.join(unit_dir, timer)) for timer in TIMERS)


def after_restore(root, stack, skip, unit_dir=UNIT_DIR, install_fn=None):
    """Installs the timers on a server a bundle just came back on; returns what to say.
    One that has them keeps its own: the dev host restoring into a throwaway k3s still bundles dev."""
    if skip:
        return "backup timers not installed (--no-timers): the move's `open` installs them"
    if present(unit_dir):
        return "backup timers kept: this server already has its own"
    return "backup timers enabled: %s" % ", ".join((install_fn or install)(root, stack))


def install(root, stack):
    """Writes both units and their timers, then enables and starts the timers; returns the timer names."""
    for name, (description, script, schedule) in UNITS.items():
        fields = {"description": description, "root": root, "script": script, "stack": stack, "schedule": schedule}
        with open(os.path.join(UNIT_DIR, name + ".service"), "w") as f:
            f.write(_SERVICE.format(**fields))
        with open(os.path.join(UNIT_DIR, name + ".timer"), "w") as f:
            f.write(_TIMER.format(**fields))
    timers = [name + ".timer" for name in UNITS]
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", *timers], check=True, capture_output=True)
    return timers
