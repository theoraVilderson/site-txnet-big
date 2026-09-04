#!/usr/bin/env python3
"""Mechanically enforce docs/00-PROTOCOL.md. No dependencies. Exit 1 on failure.

Checks:
  1. every unit file has valid front matter with the required keys
  2. INDEX.md <= 40 lines, contract.md <= 250 lines
  3. status: active implies a non-empty `source:` whose paths exist
  4. depends_on points at real unit ids  (and derives the consumer map)
  5. ASSUMED(YYYY-MM-DD) tags older than MAX_AGE_DAYS
  6. open-questions rows without a date
  7. every unit is reachable from MASTER_INDEX.md
"""
import re
import sys
import glob as globlib
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
UNIT_LAYERS = ("domains", "interfaces", "platform")
REQUIRED_KEYS = ("id", "layer", "status")
MAX_INDEX_LINES = 40
MAX_CONTRACT_LINES = 250
MAX_AGE_DAYS = 30

errors: list[str] = []
warnings: list[str] = []


def parse_front_matter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    fm, key = {}, None
    for line in text[3:end].splitlines():
        if not line.strip():
            continue
        if re.match(r"^\s+-\s", line):  # list item
            if key:
                fm.setdefault(key, [])
                if isinstance(fm[key], list):
                    fm[key].append(line.strip()[1:].strip())
            continue
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            fm[key] = [v.strip() for v in inner.split(",") if v.strip()]
        elif val == "":
            fm[key] = []
        else:
            fm[key] = val
    return fm


def unit_dirs():
    for layer in UNIT_LAYERS:
        base = DOCS / layer
        if not base.exists():
            continue
        for idx in base.rglob("INDEX.md"):
            if idx.parent == base:
                continue  # the layer's own INDEX, not a unit
            yield idx.parent


def main() -> int:
    units, tmpl = {}, re.compile(r"_TEMPLATE")

    for d in unit_dirs():
        if tmpl.search(str(d)):
            continue
        idx = d / "INDEX.md"
        fm = parse_front_matter(idx)
        rel = idx.relative_to(ROOT)

        for k in REQUIRED_KEYS:
            if k not in fm:
                errors.append(f"{rel}: missing front-matter key '{k}'")
        uid = fm.get("id")
        if uid:
            if uid in units:
                errors.append(f"{rel}: duplicate unit id '{uid}'")
            units[uid] = fm

        n = len(idx.read_text(encoding="utf-8").splitlines())
        if n > MAX_INDEX_LINES:
            errors.append(f"{rel}: INDEX is {n} lines (max {MAX_INDEX_LINES}) — it is a router, not content")

        c = d / "contract.md"
        if c.exists():
            n = len(c.read_text(encoding="utf-8").splitlines())
            if n > MAX_CONTRACT_LINES:
                errors.append(f"{c.relative_to(ROOT)}: {n} lines (max {MAX_CONTRACT_LINES}) — split the unit")
        elif fm.get("status") == "active":
            errors.append(f"{rel}: status active but no contract.md")

        if fm.get("status") == "active":
            src = fm.get("source") or []
            if not src:
                errors.append(f"{rel}: status active with empty source: — mark it draft or fill real paths")
            for pattern in src:
                if not globlib.glob(str(ROOT / pattern), recursive=True):
                    errors.append(f"{rel}: source path does not exist: {pattern}")

    # dependency + consumer map
    consumers: dict[str, list[str]] = {u: [] for u in units}
    for uid, fm in units.items():
        for dep in fm.get("depends_on") or []:
            if dep not in units:
                errors.append(f"unit '{uid}': depends_on unknown unit '{dep}'")
            else:
                consumers[dep].append(uid)

    # ASSUMED age + undated open questions
    today = date.today()
    for md in DOCS.rglob("*.md"):
        if tmpl.search(str(md)):
            continue
        text = md.read_text(encoding="utf-8")
        for m in re.finditer(r"ASSUMED\((\d{4}-\d{2}-\d{2})\)", text):
            age = (today - datetime.strptime(m.group(1), "%Y-%m-%d").date()).days
            if age > MAX_AGE_DAYS:
                warnings.append(f"{md.relative_to(ROOT)}: ASSUMED from {m.group(1)} is {age} days old — confirm or promote it")
        if md.name == "open-questions.md":
            for line in text.splitlines():
                if line.startswith("|") and not re.match(r"^\|\s*(-|Date)", line):
                    if not re.search(r"\d{4}-\d{2}-\d{2}", line):
                        errors.append(f"{md.relative_to(ROOT)}: open question without a date: {line.strip()[:60]}")

    # reachability
    master = (DOCS / "MASTER_INDEX.md")
    if master.exists():
        mtext = master.read_text(encoding="utf-8")
        for uid in units:
            if uid not in mtext:
                errors.append(f"unit '{uid}' is not listed in MASTER_INDEX.md")

    print(f"units: {len(units)}")
    for uid in sorted(consumers):
        if consumers[uid]:
            print(f"  {uid} <- {', '.join(sorted(consumers[uid]))}")
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
