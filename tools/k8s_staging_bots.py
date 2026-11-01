#!/usr/bin/env python3
"""`staging.sh bots`: the owner talks to staging's platform bots (hosting R18, OPS-1-ah-p).

Staging has no route in, and the dev bots' webhooks point at the dev stack, which
is stopped while staging is up. For as long as this runs, in the foreground as
`open` does, each dev bot is staging's:
1. its webhook (address, allowed updates) recorded in STATE_FILE, then removed;
2. its updates long-polled from this host, and only those one of the owner's chats
   sent (STAGING_OWNER_CHATS) posted to staging's bot-service through a
   `kubectl port-forward`, with the bot's own webhook secret; the rest dropped;
3. at Ctrl-C or SIGTERM, or at `down` after a crash, the webhook set back as recorded.
A dev stack that starts with none registers its own (BOT_WEBHOOK_AUTO_REGISTER).
A passed twin starts it on its own as the transient unit UNIT (`journalctl -u
txnet-staging-bots`), and `down` (send's close too) stops it: nothing to remember.
The scrub keeps the owner's chats real and the gate writes to no other chat.
"""
import json
import os
import select
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging as ks  # noqa: E402
import k8s_staging_gate as kg  # noqa: E402
import k8s_staging_keys as kk  # noqa: E402
import k8s_staging_scrub as sc  # noqa: E402

STATE_FILE = ks.STATE_FILE.with_name("staging-bots.json")
UNIT = "txnet-staging-bots"
# A unit starts with an empty environment: the caller's way out to the bot API goes with it.
PROXY_VARS = ("http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY")
BOT_SERVICE = "bot-service"
# Long poll: Telegram holds the request open up to this long when nothing comes.
POLL_S = 25
API_TIMEOUT_S = POLL_S + 10
RETRY_S = 5
FORWARD_READY_S = 15
DELIVER_TIMEOUT_S = 15


def sender(update: dict) -> str | None:
    """Who sent an update: every kind a person causes carries `from`."""
    for value in update.values():
        if isinstance(value, dict) and isinstance(value.get("from"), dict):
            return str(value["from"]["id"])
    return None


def from_owner(platform: str, update: dict, owners: frozenset[tuple[str, str]]) -> bool:
    return (platform, sender(update)) in owners


def delivery(port: int, platform: str, webhook_path: str, secret: str) -> tuple[str, dict]:
    """bot-service's own webhook route (webhook.controller.ts), through the forward."""
    return (f"http://127.0.0.1:{port}/api/bots/{platform}/{webhook_path}",
            {"Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret})


def api_caller(env: dict):
    """call(bot, method, params): the bot API from this host, as the dev stack calls it."""
    bases = {p: env.get(f"{p.upper()}_API_BASE") or base for p, base in kg.DEFAULT_UPSTREAMS.items()}

    def call(bot: kk.DevBot, method: str, params: dict | None = None):
        request = urllib.request.Request(f"{bases[bot.platform].rstrip('/')}/bot{bot.token}/{method}",
                                         data=json.dumps(params or {}).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=API_TIMEOUT_S) as response:
            answer = json.loads(response.read())
        if not answer.get("ok"):
            raise ks.StagingError(f"{bot.platform} {method}: {answer.get('description')}")
        return answer["result"]
    return call


def take(bots: list[kk.DevBot], call, state: Path = STATE_FILE) -> None:
    """Each dev bot's webhook recorded, then removed: the record is written first."""
    infos = {b.platform: call(b, "getWebhookInfo") for b in bots}
    record = {p: {"url": i.get("url") or "", "allowed_updates": i.get("allowed_updates") or []}
              for p, i in infos.items()}
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps(record))
    state.chmod(0o600)
    for bot in bots:
        call(bot, "deleteWebhook")


def give_back(bots: list[kk.DevBot], call, state: Path = STATE_FILE) -> None:
    """Each recorded webhook set back with the dev bot's own secret; the record spent."""
    if not state.exists():
        return
    record = json.loads(state.read_text())
    for bot in bots:
        hook = record.get(bot.platform) or {}
        if hook.get("url"):
            call(bot, "setWebhook", {"url": hook["url"], "secret_token": bot.secret,
                                     "allowed_updates": hook.get("allowed_updates") or []})
            print(f"bots: {bot.platform}'s dev webhook set back")
    state.unlink()


def give_back_dev_bots() -> None:
    """`down`'s: a webhook a crashed `bots` left taken, set back."""
    if STATE_FILE.exists():
        env = kk.dev_env()
        give_back(kk.dev_bots(env), api_caller(env))


def unit_argv(root: Path, environ) -> list[str]:
    """`bots` as a transient unit: only the proxy variables are carried; the tokens
    stay in .env.dev, which it reads itself."""
    carried = [f"--setenv={k}={environ[k]}" for k in PROXY_VARS if environ.get(k)]
    return ["systemd-run", f"--unit={UNIT}", "--collect", f"--working-directory={root}", *carried,
            "python3", f"{root}/tools/k8s_staging.py", "bots"]


def start_background(owners: frozenset[tuple[str, str]], run=subprocess.run) -> None:
    """After a passed twin: `bots` until `down`, when the owner has chats to talk from."""
    if not owners:
        print(f"bots: no {sc.kp.OWNERS_VAR} in .env.dev, so staging's bots talk to no one")
        return
    run(["systemctl", "stop", UNIT], check=False, capture_output=True)  # a stale one gives its bots back
    done = run(unit_argv(ROOT, os.environ), check=False, capture_output=True, text=True)
    print(f"bots: staging's bots answer the owner's chats until `down` (journalctl -u {UNIT})" if done.returncode == 0
          else f"bots: did not start ({done.stderr.strip()}); `staging.sh bots` by hand")


def stop_background(run=subprocess.run) -> None:
    """`down`'s: the unit stopped; its SIGTERM gives the dev webhooks back."""
    run(["systemctl", "stop", UNIT], check=False, capture_output=True)


def _interrupted(*_):
    raise KeyboardInterrupt


def webhook_paths() -> dict[str, str]:
    """{platform: webhookPath} of staging's platform bots, the dev bots since the scrub."""
    rows = sc.psql(f"SELECT platform || ' ' || \"webhookPath\" FROM automation.bot_integration WHERE "
                   f"\"tenantId\" = {kk.OWNER} AND role = 'primary' AND status = 'active';")
    return dict(line.split(" ", 1) for line in rows.split("\n") if " " in line)


def forward() -> tuple[subprocess.Popen, int]:
    """`kubectl port-forward` to bot-service's Service, on a port kubectl picks."""
    kubectl = sc.KUBECTL
    port = subprocess.run([*kubectl, "get", "service", BOT_SERVICE, "-o", "jsonpath={.spec.ports[0].port}"],
                          check=True, text=True, capture_output=True).stdout.strip()
    proc = subprocess.Popen([*kubectl, "port-forward", f"service/{BOT_SERVICE}", f":{port}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if select.select([proc.stdout], [], [], FORWARD_READY_S)[0]:
        line = proc.stdout.readline()
        if line.startswith("Forwarding from 127.0.0.1:"):
            return proc, int(line.split("127.0.0.1:", 1)[1].split()[0])
    proc.kill()
    raise ks.StagingError(f"port-forward to {BOT_SERVICE} did not listen in {FORWARD_READY_S}s")


def relay(bot: kk.DevBot, call, path: str, owners, port_of) -> None:
    """One bot's updates, long-polled until the process ends; an owner's posted to staging."""
    offset = None
    while True:
        try:
            updates = call(bot, "getUpdates", {"timeout": POLL_S, **({"offset": offset} if offset else {})})
        except (OSError, ks.StagingError) as e:
            print(f"bots: {bot.platform} getUpdates: {e}; again in {RETRY_S}s", flush=True)
            time.sleep(RETRY_S)
            continue
        for item in updates:
            offset = item["update_id"] + 1
            if not from_owner(bot.platform, item, owners):
                continue
            url, headers = delivery(port_of(), bot.platform, path, bot.secret)
            request = urllib.request.Request(url, data=json.dumps(item).encode(), headers=headers)
            try:
                urllib.request.urlopen(request, timeout=DELIVER_TIMEOUT_S).close()
            except (urllib.error.URLError, OSError) as e:
                print(f"bots: {bot.platform} update {item['update_id']} not delivered: {e}", flush=True)


def serve_bots(docker) -> None:
    if docker(["docker", "inspect", ks.CONTAINER], check=False).returncode != 0:
        raise ks.StagingError("staging is not up: `up`, then `restore` or `twin`")
    env = kk.dev_env()
    owners = sc.owner_chats()
    paths = webhook_paths()
    bots = [b for b in kk.dev_bots(env) if b.platform in paths]
    if not owners or not bots:
        raise ks.StagingError(f"nothing to relay: set {sc.kp.OWNERS_VAR} and a dev bot in .env.dev, "
                              "and restore production's data (its platform bots become the dev bots)")
    call = api_caller(env)
    signal.signal(signal.SIGTERM, _interrupted)  # systemctl stop: the same way out as Ctrl-C
    forwarding = {"proc": None, "port": 0}
    forwarding["proc"], forwarding["port"] = forward()
    take(bots, call)
    try:
        for bot in bots:
            threading.Thread(target=relay, args=(bot, call, paths[bot.platform], owners,
                                                 lambda: forwarding["port"]), daemon=True).start()
        chats = ", ".join(f"{p}:{c}" for p, c in sorted(owners))
        print(f"staging's bots answer {chats} through {', '.join(b.username or b.platform for b in bots)}; "
              "everyone else's messages are dropped. Ctrl-C gives the dev stack its bots back.", flush=True)
        while True:
            time.sleep(RETRY_S)
            if forwarding["proc"].poll() is not None:  # a port-forward ends now and then
                forwarding["proc"], forwarding["port"] = forward()
    except KeyboardInterrupt:
        print("\nstaging's bots are closed")
    finally:
        give_back(bots, call)
        forwarding["proc"].kill()
