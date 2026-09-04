#!/usr/bin/env python3
"""Resolve a feature id to exactly the spec text an agent needs. Nothing more.

This is the token primitive of the whole skeleton. A backlog row's `spec ref`
is a feature **id**, never a line range — line numbers rot on the first edit of
the catalog. This tool re-derives the range on every call, so it is always
correct.

usage:
    python3 tools/spec.py F-0705          the feature's block, printed
    python3 tools/spec.py F-0705 --row    just the one table row
    python3 tools/spec.py --area 07       every feature in section 07
    python3 tools/spec.py --todo          catalog ids with no backlog row yet
    python3 tools/spec.py --list          every id + title (the cheap overview)
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from importlib import import_module
    fs = import_module("features-scan")
except Exception:  # pragma: no cover
    fs = import_module("features_scan")

MAX_PRINT = 150


def find(features, fid):
    for f in features:
        if f["id"].upper() == fid.upper():
            return f
    return None


def print_block(f, full=False):
    b = f["block"]
    print(f"# {f['id']}  [{f['status']}]  {f['feature']}")
    if f["depends_on"]:
        print(f"# depends_on: {' '.join(f['depends_on'])}")
    if f["note"]:
        print(f"# note: {f['note']}")
    print(f"# block: {b['file'].name}:{b['start']}-{b['end']}  ({b['title']})")
    if b["dci"]:
        print(f"# decisions/constraints/invariants in this block: {' '.join(b['dci'])}")
    print("#" + "-" * 70)
    body = b["body"]
    if len(body) > MAX_PRINT and not full:
        print("\n".join(body[:MAX_PRINT]))
        print(f"\n… {len(body) - MAX_PRINT} more lines. "
              f"Re-run with --full only if the block above was not enough.")
    else:
        print("\n".join(body))


def main() -> int:
    args = [a for a in sys.argv[1:]]
    blocks, features = fs.load_all()
    if not features:
        print("no features found — is docs/features/App-Features.md present "
              "and in FEATURES-FORMAT.md shape?", file=sys.stderr)
        return 2

    if "--list" in args:
        for f in sorted(features, key=lambda x: (len(x["id"]), x["id"])):
            print(f"{f['id']}  {f['status']:8}  {f['feature'][:80]}")
        return 0

    if "--todo" in args:
        bl, dr = fs.backlog_ids(), fs.dropped_ids()
        first: dict[str, dict] = {}
        for f in features:                       # a cross-referenced id is one
            first.setdefault(f["id"], f)         # feature; its first row defines it
        pending = [f for f in first.values()
                   if f["id"] not in bl and f["id"] not in dr]
        if not pending:
            print("every catalog feature has a backlog row or is in DROPPED.md")
            return 0
        by_area: dict[str, list] = {}
        for f in pending:
            by_area.setdefault(f["block"]["area"] or "??", []).append(f)
        print(f"{len(pending)} catalog features not yet ingested:\n")
        for area in sorted(by_area):
            print(f"  Section {area}  ({len(by_area[area])})")
            for f in by_area[area][:6]:
                print(f"    {f['id']}  {f['feature'][:66]}")
            if len(by_area[area]) > 6:
                print(f"    … {len(by_area[area]) - 6} more")
        print("\nIngest one area at a time: MODE: INGEST in docs/00-PROTOCOL.md")
        return 0

    if "--area" in args:
        area = args[args.index("--area") + 1].zfill(2)
        hit = [f for f in features if (f["block"]["area"] or "") == area]
        if not hit:
            print(f"no features in section {area}", file=sys.stderr)
            return 1
        seen_blocks = []
        for f in hit:
            if f["block"] not in seen_blocks:
                seen_blocks.append(f["block"])
        print(f"# Section {area} — {len(hit)} features in "
              f"{len(seen_blocks)} block(s)\n")
        for b in seen_blocks:
            print(f"## {b['title']}   ({b['file'].name}:{b['start']}-{b['end']})")
            print("\n".join(b["body"][1:]))
            print()
        return 0

    ids = [a for a in args if re.fullmatch(r"[Ff]-\d{3,4}", a)]
    if not ids:
        print(__doc__)
        return 1

    for fid in ids:
        f = find(features, fid)
        if not f:
            print(f"{fid}: not in the catalog. "
                  f"Check DROPPED.md, or the id was renumbered (forbidden).",
                  file=sys.stderr)
            return 1
        if "--row" in args:
            print(f"{f['id']} | {f['feature']} | {f['status']} | "
                  f"{' '.join(f['depends_on']) or '—'} | {f['note']}")
        else:
            print_block(f, full="--full" in args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
