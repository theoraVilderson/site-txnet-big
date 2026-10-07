#!/usr/bin/env python3
"""The platform zone holds what a reseller's domain needs (EDGE-1-i).

ADR-0129 (1, 2) and amendment 1. A reseller CNAMEs its domain to
`<slug>.edge.<domain>`; Cloudflare sends it, as a Custom Hostname, to the
fallback origin. So the zone needs three things, and this makes them exactly
once, from the same env the services read:

  - `EDGE_FALLBACK_ORIGIN` (e.g. edge-origin.<domain>): a proxied A record to
    the origin, never DNS-only (the address would be public);
  - `*.edge.<domain>`: a proxied CNAME to it;
  - the zone's Custom Hostnames fallback origin set to it.

    edge_zone.py plan              what `apply` would change, changing nothing
    edge_zone.py apply             make the three; EDGE_ORIGIN_IP is needed only
                                   when the origin record does not exist yet
    edge_zone.py repoint OLD NEW   the origin's address changed (go-live): every
                                   A record on OLD moves to NEW, proxy state kept
    edge_zone.py status            the three as the zone holds them

Every run lists the DNS-only records that name the origin's address: each one
publishes it. They are reported, never changed (mail has to stay DNS-only).
Reads CLOUDFLARE_API_TOKEN (Zone / DNS / Edit and Zone / SSL and Certificates /
Edit), CLOUDFLARE_ZONE_ID, DOMAIN_NAME and EDGE_FALLBACK_ORIGIN from the
environment, or from ENV_FILE (e.g. ENV_FILE=.env.prod, read on top of .env).
Contract: docs/domains/tenant/contract.domains.md "Go-live".
"""
import ipaddress
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from collections import namedtuple

API = "https://api.cloudflare.com/client/v4"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

Plan = namedtuple("Plan", "changes leaks")


class ZoneError(ValueError):
    pass


def _ipv4(value, what):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError as e:
        raise ZoneError(f"{what}: {value!r} is not an address") from e
    if ip.version != 4:
        raise ZoneError(f"{what}: {value} is not IPv4 (the origin record is an A record)")
    return str(ip)


def _one(records, name):
    found = [r for r in records if r["name"] == name and r["type"] in ("A", "AAAA", "CNAME")]
    if len(found) > 1:
        raise ZoneError(f"{name}: {len(found)} records; remove the extra ones by hand, nothing is guessed")
    return found[0] if found else None


def _want(current, body):
    if current is None:
        return [("create", None, body)]
    if any(current.get(k) != v for k, v in body.items()):
        return [("update", current["id"], body)]
    return []


def plan(records, domain, fallback, origin_ip, current_fallback):
    """The zone's records -> Plan(changes, leaks). Pure; raises ZoneError."""
    domain, fallback = domain.lower().rstrip("."), fallback.lower().rstrip(".")
    wildcard = f"*.edge.{domain}"
    if not fallback.endswith("." + domain):
        raise ZoneError(f"EDGE_FALLBACK_ORIGIN {fallback} is not inside {domain}")
    if fallback.endswith(".edge." + domain):
        raise ZoneError(f"EDGE_FALLBACK_ORIGIN {fallback} is under {wildcard}: it would point at itself")

    origin = _one(records, fallback)
    changes = []
    if origin_ip is not None:
        changes += _want(origin, {"type": "A", "name": fallback, "content": _ipv4(origin_ip, "EDGE_ORIGIN_IP"),
                                   "proxied": True})
    elif origin is None:
        raise ZoneError(f"{fallback} does not exist; set EDGE_ORIGIN_IP to the origin's address")
    elif not origin["proxied"]:
        changes.append(("update", origin["id"], {**_body(origin), "proxied": True}))
    changes += _want(_one(records, wildcard), {"type": "CNAME", "name": wildcard, "content": fallback,
                                               "proxied": True})
    if current_fallback != fallback:
        changes.append(("fallback", None, {"origin": fallback}))

    address = origin_ip or (origin["content"] if origin and origin["type"] == "A" else None)
    leaks = sorted(r["name"] for r in records if address and r["type"] == "A" and r["content"] == address
                   and not r["proxied"])
    return Plan(changes, leaks)


def _body(r):
    return {"type": r["type"], "name": r["name"], "content": r["content"], "proxied": r["proxied"]}


def repoint(records, old, new):
    """Every A record on `old` -> `new`, proxy state kept. Pure; raises ZoneError."""
    old, new = _ipv4(old, "OLD"), _ipv4(new, "NEW")
    if old == new:
        raise ZoneError("OLD and NEW are the same address")
    moving = [r for r in records if r["type"] == "A" and r["content"] == old]
    if not moving:
        raise ZoneError(f"no A record holds {old}; nothing to move")
    return [("update", r["id"], {**_body(r), "content": new}) for r in moving]


# --- Cloudflare -------------------------------------------------------------

def load_env():
    env = dict(os.environ)
    if os.environ.get("ENV_FILE"):
        files = " ".join(f'. "{os.path.join(ROOT, f)}";' for f in (".env", os.environ["ENV_FILE"])
                         if os.path.exists(os.path.join(ROOT, f)))
        out = subprocess.run(["bash", "-c", f"set -a; {files} env -0"], check=True, capture_output=True).stdout
        env.update(kv.split("=", 1) for kv in out.decode().split("\0") if "=" in kv)
    missing = [k for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "DOMAIN_NAME", "EDGE_FALLBACK_ORIGIN")
               if not env.get(k)]
    if missing:
        raise ZoneError(f"set {', '.join(missing)} (or ENV_FILE)")
    return env


def cf(env, method, path, body=None):
    req = urllib.request.Request(f"{API}/zones/{env['CLOUDFLARE_ZONE_ID']}/{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {env['CLOUDFLARE_API_TOKEN']}",
                                          "Content-Type": "application/json"})
    for attempt in (1, 2):  # the path out of Iran drops a handshake now and then
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                data = json.load(res)
            break
        except urllib.error.HTTPError as e:
            data = json.load(e)
            break
        except urllib.error.URLError as e:
            if attempt == 2:
                raise ZoneError(f"{method} {path}: {e.reason}") from e
    if not data.get("success"):
        raise ZoneError(f"{method} {path}: {data.get('errors')}")
    return data["result"]


def zone_state(env):
    records = cf(env, "GET", "dns_records?per_page=5000")
    try:
        current = cf(env, "GET", "custom_hostnames/fallback_origin").get("origin")
    except ZoneError:
        current = None  # none set yet answers an error
    return records, current


def send(env, changes):
    for op, rid, body in changes:
        if op == "create":
            cf(env, "POST", "dns_records", body)
        elif op == "update":
            cf(env, "PUT", f"dns_records/{rid}", body)
        else:
            cf(env, "PUT", "custom_hostnames/fallback_origin", body)
        print(f"  done: {op} {body.get('name', body.get('origin'))}")


def show(changes, leaks):
    for op, _, body in changes:
        print(f"  {op:8} {body.get('name', 'fallback origin')} -> {body.get('content', body.get('origin'))}"
              + ("" if "proxied" not in body else (" proxied" if body["proxied"] else " DNS-only")))
    if not changes:
        print("  nothing to change")
    for name in leaks:
        print(f"  WARNING  {name} is DNS-only on the origin's address: it publishes it")


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd not in ("plan", "apply", "repoint", "status") or (cmd == "repoint") != (len(argv) == 4):
        print(__doc__.split("\n\n")[3], file=sys.stderr)
        return 2
    env = load_env()
    records, current = zone_state(env)
    if cmd == "repoint":
        changes = repoint(records, argv[2], argv[3])
        show(changes, [])
        send(env, changes)
        return 0
    p = plan(records, env["DOMAIN_NAME"], env["EDGE_FALLBACK_ORIGIN"], env.get("EDGE_ORIGIN_IP") or None, current)
    if cmd == "status":
        for name in (env["EDGE_FALLBACK_ORIGIN"], f"*.edge.{env['DOMAIN_NAME']}"):
            r = _one(records, name)
            print(f"  {name}: " + (f"{r['type']} -> {'<address>' if r['type'] == 'A' else r['content']}"
                                    f" {'proxied' if r['proxied'] else 'DNS-only'}" if r else "missing"))
        print(f"  fallback origin: {current or 'not set'}")
        show(p.changes, p.leaks)
        return 0
    show(p.changes, p.leaks)
    if cmd == "apply":
        send(env, p.changes)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except ZoneError as e:
        print(f"edge_zone: {e}", file=sys.stderr)
        sys.exit(1)
