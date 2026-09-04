#!/usr/bin/env python3
"""Read docs/BACKLOG.md and report progress + what is eligible next.

usage:
    python3 tools/backlog.py            progress + next eligible items
    python3 tools/backlog.py --next     print only the next item id
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKLOG = ROOT / "docs" / "BACKLOG.md"
HANDOFF = ROOT / "docs" / "HANDOFF.md"
VALID = {"todo", "doing", "done", "blocked", "dropped"}
COLS = ["id", "feature", "unit", "status", "depends_on", "spec", "proof", "note"]


def rows():
    if not BACKLOG.exists():
        print("no docs/BACKLOG.md", file=sys.stderr)
        sys.exit(2)
    out = []
    for line in BACKLOG.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 6 or cells[0].startswith("-") or cells[0].lower() == "id":
            continue
        if not re.match(r"^[A-Z]+-\d+$", cells[0]):
            continue
        if cells[1].startswith("_"):  # example row
            continue
        r = dict(zip(COLS, cells + [""] * (len(COLS) - len(cells))))
        r["status"] = r["status"].lower()
        deps = [d.strip() for d in re.split(r"[,\s]+", r["depends_on"]) if d.strip()]
        r["deps"] = [d for d in deps if re.match(r"^[A-Z]+-\d+$", d)]
        out.append(r)
    return out


def handoff_state():
    """-> (status, item). A handoff that outlives its item misleads the next
    session, so its liveness is checked here rather than trusted."""
    if not HANDOFF.exists():
        return None, None
    status = item = None
    for ln in HANDOFF.read_text(encoding="utf-8").splitlines()[1:]:
        if ln.strip() == "---":
            break
        m = re.match(r"^(status|item)\s*:\s*(\S+)", ln)
        if m:
            v = m.group(2).strip("`\"'")
            if m.group(1) == "status":
                status = v.lower()
            else:
                item = None if v in {"—", "-", "none"} else v
    return status, item


def main():
    items = rows()
    by_id = {r["id"]: r for r in items}
    errors = []

    for r in items:
        if r["status"] not in VALID:
            errors.append(f"{r['id']}: invalid status '{r['status']}'")
        for d in r["deps"]:
            if d not in by_id:
                errors.append(f"{r['id']}: depends on unknown item {d}")
        if r["status"] == "done" and not r["proof"]:
            errors.append(f"{r['id']}: marked done with no proof path")
        if r["status"] == "blocked" and not r["note"]:
            errors.append(f"{r['id']}: blocked with no blocker named")

    counts = {s: sum(1 for r in items if r["status"] == s) for s in VALID}
    live = [r for r in items if r["status"] != "dropped"]
    done = counts["done"]
    pct = (100 * done // len(live)) if live else 0

    eligible = [
        r for r in items
        if r["status"] == "todo"
        and all(by_id.get(d, {}).get("status") == "done" for d in r["deps"])
        and "needs-decision" not in r["note"]
    ]

    if "--next" in sys.argv:
        print(eligible[0]["id"] if eligible else "")
        return 0

    bar = "#" * (pct // 5) + "." * (20 - pct // 5)
    print(f"[{bar}] {pct}%   {done}/{len(live)} done")
    print("  " + "  ".join(f"{s}:{counts[s]}" for s in
                           ("todo", "doing", "done", "blocked", "dropped")))

    h_status, h_item = handoff_state()
    if h_status == "active":
        if not h_item:
            errors.append("HANDOFF.md is active but names no item")
        elif h_item not in by_id:
            errors.append(f"HANDOFF.md points at {h_item}, which is not a backlog row")
        elif by_id[h_item]["status"] != "doing":
            errors.append(
                f"HANDOFF.md is stale: {h_item} is '{by_id[h_item]['status']}', "
                f"not 'doing'. Reset it to status: empty.")
        else:
            print(f"\nHANDOFF: active on {h_item} — start the next session with /resume")

    doing = [r for r in items if r["status"] == "doing"]
    if doing:
        print("\nIN PROGRESS (finish these before starting new work):")
        for r in doing:
            print(f"  {r['id']}  {r['feature'][:50]}  [{r['unit']}]  {r['note'][:40]}")
        if h_status != "active":
            print("  (no HANDOFF.md — a fresh session cannot tell how far these got)")

    print("\nNEXT ELIGIBLE:")
    for r in eligible[:5]:
        print(f"  {r['id']}  {r['feature'][:50]}  [{r['unit']}]  spec:{r['spec']}")
    if not eligible:
        print("  none — everything is done, blocked, or waiting on a decision")

    blocked = [r for r in items if r["status"] == "blocked"
               or (r["status"] == "todo" and "needs-decision" in r["note"])]
    if blocked:
        print("\nWAITING ON YOU:")
        for r in blocked:
            print(f"  {r['id']}  {r['note'][:70]}")

    for e in errors:
        print(f"ERROR {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
