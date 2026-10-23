"""The two systemd timers: the nightly bundle and the ship every 10 minutes (OPS-1-ad).

Written from this checkout's path and stack, so the units never name a path
that is not there (scripts/dev-guard's units hardcode theirs).
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
