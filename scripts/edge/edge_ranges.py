#!/usr/bin/env python3
"""The approved edges' published ranges, re-read and their last good copy kept.

NIN-1-b1, ADR-0165 points 3 and 7; O8's rules for every edge. `edges.json`,
beside this file, is the list: one row per edge with where its ranges are read,
the format of that answer, the header it names the visitor in, and the fewest
ranges per family a real answer has. A firewall asks `ranges(name)` for the
ranges it admits; nothing else fetches them.

    edge_ranges.py refresh    re-read every edge, keep each good answer
    edge_ranges.py print      each edge's ranges as they stand, changing nothing
    edge_ranges.py install    /etc/cron.d entry: at boot and daily

An answer that is short, malformed, too wide or failed to arrive is refused and
that edge's last good copy (STATE_DIR/<name>.json) is used instead; with none,
the edge fails and nothing changes. Each edge's last good answer is exported to
node-exporter's textfile directory, where EdgeRangesStale alerts after 3 days.
Contract: docs/platform/hosting/contract.origin.md.
"""
import ipaddress
import json
import os
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
EDGES_FILE = os.path.join(HERE, "edges.json")
STATE_DIR = os.environ.get("EDGE_RANGES_STATE", "/var/lib/txnet/edge-ranges")
TEXTFILE_DIR = os.environ.get("NODE_TEXTFILE_DIR", "/var/lib/txnet/node-textfile")
METRIC = "txnet_edge_ranges_last_refresh_timestamp_seconds"
CRON = "/etc/cron.d/txnet-edge-ranges"
FAMILIES = (4, 6)
FIELDS = ("name", "source", "format", "visitor_header", "minimum")
# No edge publishes anything wider than this; a wider one admits the world.
WIDEST = {4: 8, 6: 16}
FETCH_TIMEOUT_S = 30


class RangeError(ValueError):
    pass


def _cloudflare_api(body):
    data = json.loads(body)
    result = data["result"] if data.get("success") else None
    return {4: result["ipv4_cidrs"], 6: result["ipv6_cidrs"]}


def _lines(body):
    """One range per line, either family (Arvan's ips.txt); '#' starts a comment."""
    cidrs = [line.split("#")[0].strip() for line in body.splitlines()]
    lists = {4: [], 6: []}
    for cidr in filter(None, cidrs):
        lists[6 if ":" in cidr else 4].append(cidr)
    return lists


# The value of an edge's `format`: how its answer reads into {4: [...], 6: [...]}.
PARSERS = {"cloudflare-api": _cloudflare_api, "lines": _lines}


def _key(family):
    return f"ipv{family}"


def load_edges(path=EDGES_FILE):
    """edges.json -> {name: row}, or RangeError for a row the parsers cannot serve."""
    with open(path) as f:
        rows = json.load(f)["edges"]
    edges = {}
    for row in rows:
        missing = [k for k in FIELDS if k not in row]
        floors = row.get("minimum", {})
        if missing or row["format"] not in PARSERS or any(_key(f) not in floors for f in FAMILIES):
            raise RangeError(f"{path}: row {row.get('name')!r} is incomplete or names an unknown format")
        edges[row["name"]] = row
    return edges


def check(edge, lists):
    """Refuse a list O8 would refuse: under the edge's floor, malformed, wrong family, too wide."""
    for family in FAMILIES:
        cidrs, floor = lists[family], edge["minimum"][_key(family)]
        if len(cidrs) < floor:
            raise RangeError(f"{edge['name']} IPv{family}: {len(cidrs)} ranges, expected at least {floor}")
        for cidr in cidrs:
            try:
                net = ipaddress.ip_network(cidr)
            except ValueError as e:
                raise RangeError(f"{edge['name']} IPv{family}: {cidr!r}: {e}") from e
            if net.version != family or net.prefixlen < WIDEST[family]:
                raise RangeError(f"{edge['name']} IPv{family}: {cidr} is not an edge range")
    return lists


def parse(edge, body):
    """An edge's answer -> {4: [...], 6: [...]}, or RangeError."""
    try:
        lists = PARSERS[edge["format"]](body)
    except (ValueError, TypeError, KeyError) as e:
        raise RangeError(f"not {edge['name']}'s list: {e}") from e
    return check(edge, lists)


def fetch(url):
    with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT_S) as resp:
        return resp.read().decode()


def _copy_path(edge):
    return os.path.join(STATE_DIR, edge["name"] + ".json")


def _replace(path, text):
    """Written beside the target and renamed over it: a reader sees the old or the new file, whole."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def _read_copy(edge):
    """The last good copy, held to today's floors, as (lists, fetched_at)."""
    try:
        with open(_copy_path(edge)) as f:
            copy = json.load(f)
        lists = {family: copy[_key(family)] for family in FAMILIES}
        return check(edge, lists), copy["fetched_at"]
    except (OSError, ValueError, KeyError) as e:
        raise RangeError(f"{edge['name']}: no good copy at {_copy_path(edge)} ({e})") from e


def write_metrics():
    """Each kept copy's time as node-exporter's edge_ranges.prom. Kept here, not
    shared with scripts/bundle: this directory is copied to a node on its own."""
    if not os.path.isdir(TEXTFILE_DIR):
        return
    lines = [f"# TYPE {METRIC} gauge\n"]
    for edge in load_edges().values():
        try:
            _, fetched_at = _read_copy(edge)
        except RangeError:
            continue
        lines.append(f'{METRIC}{{edge="{edge["name"]}"}} {fetched_at:.0f}\n')
    _replace(os.path.join(TEXTFILE_DIR, "edge_ranges.prom"), "".join(lines))


def refresh(edge, fetch=fetch, now=time.time):
    """Fresh from the edge, else its last good copy, else RangeError."""
    try:
        lists = parse(edge, fetch(edge["source"]))
        copy = {"edge": edge["name"], "fetched_at": now(), **{_key(f): lists[f] for f in FAMILIES}}
        _replace(_copy_path(edge), json.dumps(copy, indent=1) + "\n")
    except (OSError, RangeError) as e:
        print(f"{edge['name']}'s list unusable ({e}); using {_copy_path(edge)}", file=sys.stderr)
        lists, _ = _read_copy(edge)
    write_metrics()
    return lists


def ranges(name):
    """The ranges a firewall admits for one edge, re-read now."""
    return refresh(load_edges()[name])


def install():
    me = os.path.abspath(__file__)
    with open(CRON, "w") as f:
        f.write("# NIN-1-b1: re-read every approved edge's ranges, keep the last good copy.\n"
                f"@reboot root sleep 60 && /usr/bin/python3 {me} refresh\n"
                f"13 4 * * * root /usr/bin/python3 {me} refresh\n")
    print(f"wrote {CRON}")


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "install":
        return install()
    if cmd not in ("refresh", "print"):
        print(__doc__)
        return 2
    failed = 0
    for edge in load_edges().values():
        try:
            lists = refresh(edge) if cmd == "refresh" else _read_copy(edge)[0]
        except RangeError as e:
            print(e, file=sys.stderr)
            failed += 1
            continue
        print(f"{edge['name']}: {len(lists[4])} IPv4, {len(lists[6])} IPv6 ranges")
        if cmd == "print":
            print("\n".join(lists[4] + lists[6]))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv) or 0)
