"""The new server made reachable for a move by key alone (OPS-1-am-g, hosting K21).

A password reaches the server once, to install production's key; after that the
move, dns_resolvers and the release all use the key, and password login is off
(OPS-1-am, the user's decision 4: SSH by key only). A port other than 22 goes
into ~/.ssh/config, so every tool that runs `ssh` or `scp` reaches it unchanged.
"""
import os
import re
import shlex
import subprocess
import time

import cluster_fence as cf

SSH_CONFIG = os.path.expanduser("~/.ssh/config")
MARK = "# txnet-move"
# sshd keeps the first value it reads, and Ubuntu's 50-cloud-init.conf may allow passwords
KEY_ONLY_CONF = "/etc/ssh/sshd_config.d/00-txnet-key-only.conf"
KEY_ONLY_TEXT = "PasswordAuthentication no\nKbdInteractiveAuthentication no\n"
DEFAULT_PORT = 22
CONNECT_S = 60
RELOAD_TRIES, RELOAD_WAIT_S = 5, 2


def with_port(config, address, port):
    """config with one managed `Host address / Port port` block; none for port 22."""
    block = re.compile(r"%s %s\n.*?%s end\n" % (re.escape(MARK), re.escape(address), re.escape(MARK)), re.S)
    config = block.sub("", config)
    if port == DEFAULT_PORT:
        return config
    if config and not config.endswith("\n"):
        config += "\n"
    return config + "%s %s\nHost %s\n  Port %d\n%s end\n" % (MARK, address, address, port, MARK)


def install_key_script(public_key):
    """The shell that adds public_key to root's authorized_keys once."""
    quoted = shlex.quote(public_key)
    return ("umask 077; mkdir -p /root/.ssh; touch /root/.ssh/authorized_keys; "
            "grep -qxF %s /root/.ssh/authorized_keys || echo %s >> /root/.ssh/authorized_keys" % (quoted, quoted))


def refuse_user(target):
    """A refusal unless target logs in as root: the move installs packages, k3s and firewall rules."""
    user = target.split("@")[0] if "@" in target else ""
    return None if user == "root" else "the new server is reached as root@address, not %s" % target


def set_port(address, port):
    try:
        with open(SSH_CONFIG) as f:
            config = f.read()
    except FileNotFoundError:
        config = ""
    updated = with_port(config, address, port)
    if updated != config:
        os.makedirs(os.path.dirname(SSH_CONFIG), mode=0o700, exist_ok=True)
        with open(SSH_CONFIG, "w") as f:
            f.write(updated)
        os.chmod(SSH_CONFIG, 0o600)


def public_key(key):
    if os.path.exists(key + ".pub"):
        with open(key + ".pub") as f:
            return f.read().strip()
    return subprocess.run(["ssh-keygen", "-y", "-f", key], capture_output=True, text=True, check=True).stdout.strip()


def _ssh(target, key, command, password=None):
    """command on target; with a password through sshpass's environment, never its argv."""
    opts = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20"]
    if password is None:
        argv, env = ["ssh", "-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", *opts, target, command], None
    else:
        argv = ["sshpass", "-e", "ssh", *opts, "-o", "PubkeyAuthentication=no", target, command]
        env = {**os.environ, "SSHPASS": password}
    return subprocess.run(argv, capture_output=True, text=True, env=env, timeout=CONNECT_S)


def prepare(target, port, key, password=None):
    """target reachable by key at port, password login off; a MoveError says which part failed."""
    refusal = refuse_user(target)
    if refusal:
        raise cf.MoveError(refusal)
    address = target.split("@")[-1]
    set_port(address, port)
    # a run continued after the first: the key is in and the password is already refused
    if password is not None and _ssh(target, key, "true").returncode:
        done = _ssh(target, key, install_key_script(public_key(key)), password=password)
        if done.returncode:
            raise cf.MoveError("%s: the password did not let the key in: %s" % (address, done.stderr.strip()[-300:]))
    if _ssh(target, key, "true").returncode:
        raise cf.MoveError("%s:%d does not take %s; give --password once, or put its .pub there" % (address, port, key))
    # already key-only: no reload, so a second run does not race sshd's restart
    done = _ssh(target, key, "[ \"$(cat %s 2>/dev/null)\" = %s ] || { printf %s > %s && sshd -t && "
                "(systemctl reload ssh || systemctl reload sshd); }" % (
                    KEY_ONLY_CONF, shlex.quote(KEY_ONLY_TEXT.strip()), shlex.quote(KEY_ONLY_TEXT), KEY_ONLY_CONF))
    if done.returncode or not reachable(target, key):
        raise cf.MoveError("%s: password login could not be switched off: %s" % (address, done.stderr.strip()[-300:]))


def reachable(target, key, tries=RELOAD_TRIES):
    """True once target takes the key; a reloading sshd refuses for a moment."""
    for attempt in range(tries):
        if not _ssh(target, key, "true").returncode:
            return True
        time.sleep(RELOAD_WAIT_S)
    return False
