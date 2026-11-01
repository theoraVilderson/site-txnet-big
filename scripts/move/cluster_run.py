"""`cluster_move.py run`: every step of a move in one command (OPS-1-am-g, hosting K21).

The steps, their order and their refusals are cluster_move's; this only walks
them. The platform goes down at `stop` and the edges move at `repoint`, so each
waits for the word `yes` typed by the owner (OPS-1-am-d: the owner approves
those). A run that stops, refused or declined, continues at its next step when
`run` is given again for the same servers.
"""
import re

import cluster_fence as cf

ASK_BEFORE = {"move": ("stop", "repoint")}
QUESTIONS = {
    "stop": "the platform goes down now, for the stop, bundle, restore, fence and open (~8 min)",
    "repoint": "Cloudflare and Arvan now point at the new server",
}
RELEASE_HOST, RELEASE_KEY = "STAGING_PROD_SSH", "STAGING_PROD_SSH_KEY"


def say(message, *args):
    print("cluster-move: " + (message % args if args else message), flush=True)


def pending(state):
    return [s for s in cf.STEPS[state["mode"]] if s not in state["done"]]


def continues(state, mode, old, new):
    """True when state is an unfinished run of this mode between these two servers."""
    return bool(state and state["mode"] == mode and state["from"] == old and state["to"] == new and pending(state))


def run_all(state, ask, run_step):
    """Each pending step in order: 0 when all ran, 1 when one was refused or not approved."""
    for step in pending(state):
        if step in ASK_BEFORE.get(state["mode"], ()) and ask(step).strip() != "yes":
            say("stopped before `%s`; `run` again with the same servers continues here", step)
            return 1
        try:
            run_step(state, step)
        except cf.MoveError as err:
            say("REFUSED at `%s`: %s", step, err)
            say("fix that, then `run` again with the same servers: it continues at `%s`", step)
            return 1
    return 0


def release_target(env_text, target, key):
    """.env.dev text naming target as production for the release (OPS-1-am-f)."""
    for name, value in ((RELEASE_HOST, target), (RELEASE_KEY, key)):
        line = "%s=%s" % (name, value)
        pattern = re.compile(r"^%s=.*$" % name, re.M)
        if pattern.search(env_text):
            env_text = pattern.sub(line, env_text)
        else:
            env_text += ("" if env_text.endswith("\n") or not env_text else "\n") + line + "\n"
    return env_text


def release_env(path):
    """STAGING_PROD_SSH and _KEY from the build host's .env.dev: production as the release knows it."""
    try:
        with open(path) as f:
            text = f.read()
    except FileNotFoundError:
        return None, None
    found = dict(re.findall(r"^(%s|%s)=(.*)$" % (RELEASE_HOST, RELEASE_KEY), text, re.M))
    return found.get(RELEASE_HOST) or None, found.get(RELEASE_KEY) or None


def point_release_at(path, target, key):
    with open(path) as f:
        text = f.read()
    with open(path, "w") as f:
        f.write(release_target(text, target, key))
    say("%s now names %s: the next release goes there", path, target)
