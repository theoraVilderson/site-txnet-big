"""Unit status checks for docs-check.py (check 9). No dependencies.

A unit's `status` is read in two places and was checked in neither. Found
2026-10-14 (OPS-1-ab): `guide`, `governance` and `audit` were `active` in their
INDEX and `draft` in MASTER_INDEX.md for weeks, and five units that had shipped
over 200 `done` rows (network, catalog, entitlement, ai, engagement) were still
`draft` everywhere — so every session following §3 read them as schema only.

  9a. the status cell of a unit's MASTER_INDEX.md row equals its INDEX `status`
  9b. a `draft` unit owns no `done` backlog row outside the upkeep series: a
      `done` row is code that exists and is reachable, which is `active` (§6
      step 5). Upkeep rows change how code is written, not what it does, so a
      scaffold tidied by FE-1-k (`marketing-web`) can stay draft. The first
      version counted only rows with a catalog spec ref and so missed `hosting`,
      whose OPS-1/EDGE-1 rows carry none.
"""
from importlib import import_module
from pathlib import Path

# The backlog's upkeep series ("Order of work — the FE-1 front-end cleanup
# series", "the CS-1 code standard series"). A new upkeep series is added here.
UPKEEP_SERIES = ("FE-1-", "CS-1-")


def master_statuses(master: Path) -> dict[str, str]:
    """Unit id -> the status cell of its MASTER_INDEX.md row, by column name."""
    out, status_col = {}, None
    for line in master.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s.startswith("|"):
            status_col = None
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if cells[0] == "id":
            status_col = cells.index("status") if "status" in cells else None
        elif status_col is not None and not cells[0].startswith("-") and len(cells) > status_col:
            out[cells[0].strip("`")] = cells[status_col]
    return out


def check(units: dict[str, dict], master: Path) -> list[str]:
    """Errors for 9a and 9b; `units` is docs-check's id -> INDEX front matter."""
    errors = []
    listed = master_statuses(master) if master.exists() else {}
    for uid, fm in units.items():
        if uid in listed and listed[uid] != fm.get("status"):
            errors.append(f"unit '{uid}': MASTER_INDEX.md says {listed[uid]}, its INDEX says "
                          f"{fm.get('status')} — the INDEX is the record; fix the MASTER_INDEX row")

    shipped: dict[str, list[str]] = {}
    for r in import_module("backlog").rows():
        if r["status"] == "done" and not r["id"].startswith(UPKEEP_SERIES):
            shipped.setdefault(r["unit"], []).append(r["id"])
    for uid, fm in units.items():
        if fm.get("status") == "draft" and shipped.get(uid):
            ids = shipped[uid]
            errors.append(f"unit '{uid}': draft, but {len(ids)} done row(s) shipped code "
                          f"({', '.join(ids[:3])}{', …' if len(ids) > 3 else ''}) — flip it to active "
                          f"with a changelog row (§6 step 5)")
    return errors
