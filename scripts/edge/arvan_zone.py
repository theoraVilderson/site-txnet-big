"""The domestic domain's records on ArvanCloud (NIN-1-d1, ADR-0165 points 1-2).

The platform's own doors on the domestic domain — `api.`, `panel.`, `sub.` —
each an A record to the data node's 443 (O12, NIN-1-b4), the cloud on, HTTPS
to the origin (Arvan verifies no origin certificate, NIN-1-a), and the
domain's edge certificate on. An A record keeps the visitor's `Host`, which
the tenant resolver matches. Run through `edge_zone.py arvan <cmd>`.

Beside them, `*.edge` (NIN-1-e1, ADR-0165 point 7): the origin a reseller's
own edge account points at, `<slug>.edge.<domestic>`, an A record with the
cloud off, so a reseller's Arvan never chains through ours. It publishes the
address on purpose, so it is never warned as a leak.

A record is this driver's only when it has the shape it makes: an A record on
a door name, every address on DOOR_PORT (or a former one, which it moves);
an A record on the target name. Anything else on a door name (a
reseller's CNAME, a bot's port) is refused, and records on other names are
never read for a change: the zone holds the user's site and bots too.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from collections import namedtuple

from edge_zone import ROOT, ZoneError, ipv4, read_env

sys.path.insert(0, os.path.join(ROOT, "tools"))
import k8s_secrets  # noqa: E402
from k8srender.sealed import ARVAN_API_KEY_FILE  # noqa: E402

API = "https://napi.arvancloud.ir/cdn/4.0/domains"
# seed-platform-doors.js makes the same three doors (the test holds them
# equal); `pay.` was dropped by the user on 2026-10-25: a gateway returns to
# the panel the payer signed in on (NIN-1-d3).
DOOR_NAMES = ("api", "panel", "sub")
# The gateway's 443, which every approved edge reaches (hosting O7, NIN-1-b4).
DOOR_PORT = 443
# NIN-1-b2's own port for the domestic door: a door still on it is this
# driver's, and `apply` moves it to DOOR_PORT.
FORMER_DOOR_PORTS = (8443,)
# Every reseller's own-edge origin (tenant-service `cnameTargetHost`, `edge` label).
TARGET_NAME = "*.edge"
# Short, so a repoint (go-live, a move) reaches resolvers within minutes.
TTL = 120
# Arvan's largest page; the zone is read whole before any change.
PAGE = 100

Plan = namedtuple("Plan", "changes leaks")


def _ours(record):
    values = record.get("value") if isinstance(record.get("value"), list) else []
    return record["type"] == "a" and values and all(v.get("port") in (DOOR_PORT, *FORMER_DOOR_PORTS) for v in values)


def _door(records, name):
    found = [r for r in records if r["name"] == name]
    if len(found) > 1:
        raise ZoneError(f"{name}: {len(found)} records; remove the extra ones by hand, nothing is guessed")
    if found and not _ours(found[0]):
        raise ZoneError(f"{name}: a {found[0]['type']} record this driver did not make; move it off the name by "
                        "hand first (ADR-0165: the platform takes the standard names)")
    return found[0] if found else None


def _target(records):
    found = [r for r in records if r["name"] == TARGET_NAME]
    if len(found) > 1 or (found and found[0]["type"] != "a"):
        raise ZoneError(f"{TARGET_NAME}: {len(found)} record(s), not one A record; fix it by hand, nothing is guessed")
    return found[0] if found else None


def _target_body(ip):
    return {"type": "a", "name": TARGET_NAME, "value": [{"ip": ip}], "cloud": False, "ttl": TTL}


def _body(name, ip):
    return {"type": "a", "name": name, "value": [{"ip": ip, "port": DOOR_PORT}], "cloud": True,
            "upstream_https": "https", "ttl": TTL}


def _differs(current, body):
    have = [(v["ip"], v.get("port")) for v in current["value"]]
    return (have != [(v["ip"], v["port"]) for v in body["value"]] or current.get("cloud") is not True
            or current.get("upstream_https") != "https")


def plan(records, origin_ip, ssl):
    """The zone's records and SSL settings -> Plan(changes, leaks). Pure; raises ZoneError."""
    origin_ip = ipv4(origin_ip, "EDGE_ORIGIN_IP") if origin_ip else None
    changes, addresses = [], {origin_ip} - {None}
    for name in DOOR_NAMES:
        current = _door(records, name)
        if current is None and origin_ip is None:
            raise ZoneError(f"{name} does not exist; set EDGE_ORIGIN_IP to the data node's address")
        ip = origin_ip or current["value"][0]["ip"]
        addresses.add(ip)
        body = _body(name, ip)
        if current is None:
            changes.append(("create", None, body))
        elif _differs(current, body):
            changes.append(("update", current["id"], body))
    current = _target(records)
    body = _target_body(origin_ip or (current["value"][0]["ip"] if current else sorted(addresses)[0]))
    if current is None:
        changes.append(("create", None, body))
    elif [v["ip"] for v in current["value"]] != [body["value"][0]["ip"]] or current.get("cloud") is not False:
        changes.append(("update", current["id"], body))
    if not ssl.get("ssl_status"):
        changes.append(("ssl", None, {"ssl_status": True}))
    leaks = sorted(r["name"] for r in records if r["type"] == "a" and not r.get("cloud") and r["name"] != TARGET_NAME
                   and any(v.get("ip") in addresses for v in r.get("value") or []))
    return Plan(changes, leaks)


def repoint(records, old, new):
    """Each of its doors on `old` -> `new`. Pure; raises ZoneError."""
    old, new = ipv4(old, "OLD"), ipv4(new, "NEW")
    if old == new:
        raise ZoneError("OLD and NEW are the same address")
    moving = [r for r in (_door(records, name) for name in DOOR_NAMES)
              if r and any(v["ip"] == old for v in r["value"])]
    if not moving:
        raise ZoneError(f"none of {', '.join(DOOR_NAMES)} holds {old}; nothing to move")
    target = _target(records)
    tail = [("update", target["id"], _target_body(new))] if target and any(v["ip"] == old for v in target["value"]) else []
    return [("update", r["id"], _body(r["name"], new)) for r in moving] + tail


# --- ArvanCloud -------------------------------------------------------------

def load_env():
    env = read_env(("DOMESTIC_DOMAIN_NAME",))
    env.setdefault("ARVAN_API_KEY", _key())
    return env


def _key():
    """The API key: the plaintext on the host that made it, else its sealed copy
    opened in memory on the node (contract.secrets.md S4)."""
    path = os.path.join(ROOT, ARVAN_API_KEY_FILE)
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    try:
        return k8s_secrets.opened(ARVAN_API_KEY_FILE).decode().strip()
    except (k8s_secrets.SecretsError, OSError, subprocess.CalledProcessError) as e:
        raise ZoneError(f"no Arvan key: {ARVAN_API_KEY_FILE} is neither here nor opens sealed ({e})") from e


def arvan(env, method, path, body=None):
    req = urllib.request.Request(f"{API}/{env['DOMESTIC_DOMAIN_NAME']}/{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Apikey {env['ARVAN_API_KEY']}",
                                          "Content-Type": "application/json", "Accept": "application/json"})
    # A handshake is dropped now and then (2026-10-25); a create is never sent
    # twice, since a lost answer may hide a record made, which `_door` refuses.
    attempts = 1 if method == "POST" else 3
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            raise ZoneError(f"{method} {path}: {e.code} {e.read().decode(errors='replace')[:300]}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == attempts:
                raise ZoneError(f"{method} {path}: {getattr(e, 'reason', e)}") from e


def zone_state(env):
    records, page, last = [], 1, 1
    while page <= last:
        data = arvan(env, "GET", f"dns-records?per_page={PAGE}&page={page}")
        records += data["data"]
        last, page = data["meta"]["last_page"], page + 1
    return records, arvan(env, "GET", "ssl")["data"]


def send(env, changes):
    for op, rid, body in changes:
        if op == "create":
            arvan(env, "POST", "dns-records", body)
        elif op == "update":
            arvan(env, "PUT", f"dns-records/{rid}", body)
        else:
            arvan(env, "PATCH", "ssl", body)
        print(f"  done: {op} {body.get('name', 'edge certificate')}")


def show(changes, leaks, domain):
    for op, _, body in changes:
        what = ("the domain's edge certificate on" if op == "ssl"
                else f"{body['name']}.{domain} -> <address> cloud off (own edges' origin)" if body["name"] == TARGET_NAME
                else f"{body['name']}.{domain} -> <address>:{DOOR_PORT} cloud https")
        print(f"  {op:8} {what}")
    if not changes:
        print("  nothing to change")
    for name in leaks:
        print(f"  WARNING  {name}.{domain} has the cloud off on the origin's address: it publishes it")


def main(cmd, args):
    env = load_env()
    domain = env["DOMESTIC_DOMAIN_NAME"]
    records, ssl = zone_state(env)
    if cmd == "repoint":
        changes = repoint(records, *args)
        show(changes, [], domain)
        send(env, changes)
        return 0
    p = plan(records, env.get("EDGE_ORIGIN_IP") or None, ssl)
    if cmd == "status":
        for name in DOOR_NAMES:
            r = _door(records, name)
            print(f"  {name}.{domain}: " + (f"a -> <address>:{r['value'][0]['port']} cloud "
                                           f"{'on' if r.get('cloud') else 'off'} upstream {r['upstream_https']}"
                                           if r else "missing"))
        t = _target(records)
        print(f"  {TARGET_NAME}.{domain}: " + (f"a -> <address> cloud {'on' if t.get('cloud') else 'off'}" if t else "missing"))
        print(f"  edge certificate: {'on' if ssl.get('ssl_status') else 'off'}")
    show(p.changes, p.leaks, domain)
    if cmd == "apply":
        send(env, p.changes)
    return 0
