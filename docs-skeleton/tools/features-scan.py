#!/usr/bin/env python3
"""Index docs/features/App-Features*.md and validate it against FEATURES-FORMAT.md.

The catalog is never read whole by an agent. This builds a small manifest and,
with --check, proves the catalog is well-formed and fully accounted for in the
backlog.

usage:
    python3 tools/features-scan.py             rebuild docs/features/MANIFEST.md
    python3 tools/features-scan.py --check     validate format + backlog coverage
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEATURES_DIR = ROOT / "docs" / "features"
GLOB = "App-Features*.md"
MANIFEST = FEATURES_DIR / "MANIFEST.md"
DROPPED = FEATURES_DIR / "DROPPED.md"
BACKLOG = ROOT / "docs" / "BACKLOG.md"

STATUSES = {"core", "new", "changed", "partial", "later"}
# tolerated synonyms from catalogs written before this format existed
STATUS_ALIASES = {"base": "core", "existing": "core", "half": "partial",
                  "next": "later", "future": "later", "next-phase": "later",
                  "planned": "later", "done": "core", "modified": "changed"}
MAX_ROWS_PER_BLOCK = 15
MAX_BLOCK_LINES = 120

# column header -> canonical field. Tables may carry any subset, any order.
HEADER_MAP = {
    "id": "id", "#": "id", "ref": "id",
    "feature": "feature", "capability": "feature", "title": "feature",
    "status": "status", "state": "status",
    "depends_on": "depends_on", "depends": "depends_on", "deps": "depends_on",
    "note": "note", "notes": "note", "why": "note", "comment": "note",
}

SECTION_RE = re.compile(r"^##\s+Section\s+(\d{1,2})\s*[—–-]\s*(.+?)\s*$")
SUB_RE = re.compile(r"^###\s+(\d{1,2})\.(\d+)\s+(.+?)\s*$")
FID_RE = re.compile(r"\bF-\d{3,4}\b")
DCI_RE = re.compile(r"\b(?:D|C|INV)-\d{2}\b")
ENTITY_RE = re.compile(r"^([A-Z][A-Za-z0-9]+)\(")

errors: list[str] = []
warnings: list[str] = []


def catalog_files():
    if not FEATURES_DIR.exists():
        return []
    return sorted(FEATURES_DIR.glob(GLOB))


def parse(path: Path):
    """-> (blocks, features). A block is an addressable ## or ### span."""
    lines = path.read_text(encoding="utf-8").splitlines()
    heads = []
    for i, ln in enumerate(lines):
        if ln.startswith("## ") or ln.startswith("### "):
            heads.append((i, ln))

    blocks = []
    for n, (i, ln) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        m_sec, m_sub = SECTION_RE.match(ln), SUB_RE.match(ln)
        if m_sec:
            area, title, lvl = m_sec.group(1).zfill(2), m_sec.group(2), 2
        elif m_sub:
            area = m_sub.group(1).zfill(2)
            title, lvl = f"{m_sub.group(1)}.{m_sub.group(2)} {m_sub.group(3)}", 3
        else:
            area, title = None, ln.lstrip("#").strip()
            lvl = 2 if ln.startswith("## ") else 3
        body = lines[i:end]
        blocks.append({
            "file": path, "area": area, "title": title, "lvl": lvl,
            "start": i + 1, "end": end, "body": body,
            "dci": sorted(set(DCI_RE.findall("\n".join(body)))),
            "entities": sorted({m.group(1) for b in body
                                if (m := ENTITY_RE.match(b))}),
        })

    features = []
    for b in blocks:
        cols: dict[str, int] = {}
        for off, raw in enumerate(b["body"]):
            if not raw.lstrip().startswith("|"):
                cols = {}          # a non-table line ends the current table
                continue
            cells = [c.strip() for c in raw.strip().strip("|").split("|")]
            if all(set(c) <= set("-: ") for c in cells if c):
                continue           # the |---|---| separator

            # a header row re-binds the column layout for the rows beneath it
            named = {HEADER_MAP.get(c.lower().strip("* ")): i
                     for i, c in enumerate(cells)}
            named.pop(None, None)
            if "id" in named and "feature" in named:
                cols = named
                continue

            if not re.fullmatch(r"F-\d{3,4}", cells[0]):
                continue
            g = (lambda k, d="":
                 cells[cols[k]] if k in cols and cols[k] < len(cells)
                 else d)
            if cols:
                fid, feat = g("id"), g("feature")
                status, deps, note = g("status"), g("depends_on"), g("note")
            else:                  # positional fallback: id | feature | status | …
                fid, feat = cells[0], cells[1] if len(cells) > 1 else ""
                status = cells[2] if len(cells) > 2 else ""
                deps = cells[3] if len(cells) > 3 else ""
                note = cells[4] if len(cells) > 4 else ""
            # status is the FIRST word; "new ⭐", "changed (see C-09)", "new (§24)"
            # all normalise to the bare token. Anything after it is commentary.
            m_st = re.match(r"[*`\s]*([A-Za-z_-]+)", status)
            status = m_st.group(1).lower() if m_st else ""
            features.append({
                "id": fid,
                "feature": feat.replace("**", "").replace("`", "").strip(),
                "status": STATUS_ALIASES.get(status, status),
                "raw_status": status,
                "depends_on": FID_RE.findall(deps),
                "note": note if note else (deps if not FID_RE.search(deps) else ""),
                "block": b,
                "line": b["start"] + off,
            })
    return blocks, features


def load_all():
    all_blocks, all_features = [], []
    for f in catalog_files():
        b, ft = parse(f)
        all_blocks += b
        all_features += ft
    return all_blocks, all_features


def backlog_ids() -> set[str]:
    """Catalog ids cited by the backlog — from the `spec ref` column ONLY.

    The backlog's own `id` column is a separate namespace (rows found by
    RECONCILE never came from the catalog). Scanning every cell would report
    those as ghost references and bury the real findings.
    """
    if not BACKLOG.exists():
        return set()
    ids, col = set(), None
    for line in BACKLOG.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        lower = [c.lower() for c in cells]
        if "spec ref" in lower or "spec" in lower:
            col = lower.index("spec ref") if "spec ref" in lower else lower.index("spec")
            continue
        if col is not None and col < len(cells):
            ids.update(FID_RE.findall(cells[col]))
    return ids


def dropped_ids() -> set[str]:
    if not DROPPED.exists():
        return set()
    return set(FID_RE.findall(DROPPED.read_text(encoding="utf-8")))


def write_manifest(blocks, features):
    by_id = {f["id"]: f for f in features}
    FEATURES_DIR.mkdir(parents=True, exist_ok=True)
    with MANIFEST.open("w", encoding="utf-8") as fh:
        fh.write("---\nid: features-manifest\nstatus: generated\n---\n\n")
        fh.write("# Feature catalog manifest — GENERATED, do not hand-edit\n\n")
        fh.write("Rebuild: `python3 tools/features-scan.py`\n\n")
        fh.write(f"- catalog files: {len(catalog_files())}\n")
        fh.write(f"- addressable blocks: {len(blocks)}\n")
        fh.write(f"- features: {len(by_id)}\n\n")
        fh.write("**Never read the catalog directly.** "
                 "`python3 tools/spec.py <F-id>` prints exactly the block you need.\n\n")

        fh.write("## Blocks\n\n")
        fh.write("| block | lines | features | D/C/INV | entities |\n|---|---|---|---|---|\n")
        for b in blocks:
            fids = " ".join(sorted({f["id"] for f in features if f["block"] is b}))
            ind = "" if b["lvl"] == 2 else "· "
            loc = f"`{b['file'].name}:{b['start']}-{b['end']}`"
            fh.write(f"| {loc} {ind}{b['title']} | {b['end'] - b['start'] + 1} | "
                     f"{fids} | {' '.join(b['dci'])} | {' '.join(b['entities'])} |\n")

        fh.write("\n## Feature index\n\n")
        fh.write("| id | feature | status | block |\n|---|---|---|---|\n")
        for fid in sorted(by_id, key=lambda s: (len(s), s)):
            f = by_id[fid]
            fh.write(f"| {fid} | {f['feature'][:90]} | {f['status']} | "
                     f"{f['block']['title']} |\n")
    return len(by_id)


def check(blocks, features):
    """Errors are few and always real. Warnings are grouped, never per-row spam:
    a validator that cries wolf gets ignored, and then it protects nothing."""
    soft: dict[str, list[str]] = {}

    def warn(kind: str, subject: str):
        soft.setdefault(kind, []).append(subject)

    # Same id in two blocks is normal cross-referencing IF the rows say the same
    # thing. Two different capabilities sharing an id is a real defect: the
    # ingest would create one backlog row and silently lose the other feature.
    by_id: dict[str, list] = {}
    for f in features:
        by_id.setdefault(f["id"], []).append(f)
    for fid, group in by_id.items():
        if len(group) == 1:
            continue
        locs = ", ".join(f"{g['block']['file'].name}:{g['line']}" for g in group)
        blocks_hit = {id(g["block"]) for g in group}
        if len(blocks_hit) < len(group):
            errors.append(f"{fid}: listed twice in the SAME block — {locs}. "
                          f"One id, one row.")
            continue
        norm = {re.sub(r"[^a-z0-9]+", " ", g["feature"].lower()).strip()
                for g in group}
        if len(norm) == 1:
            warn("id repeated verbatim in another block (cross-reference)", fid)
        else:
            warn("id appears in several blocks with different wording — verify "
                 "they are the same feature", f"{fid} @ {locs}")

    seen: dict[str, str] = {}
    for f in features:
        where = f"{f['block']['file'].name}:{f['line']}"
        seen.setdefault(f["id"], where)
        if not f["status"]:
            warn("no status column — ingest will default these to 'new'", f["id"])
        elif f["status"] not in STATUSES:
            errors.append(f"{f['id']}: invalid status '{f['raw_status']}' "
                          f"(allowed: {', '.join(sorted(STATUSES))})")
        if f["status"] == "changed" and not re.search(r"\bC-\d{2}\b", f["note"]):
            warn("status 'changed' with no C-nn cited in note", f["id"])
        if " and " in f["feature"].lower() and len(f["feature"]) > 90:
            warn("long feature text containing 'and' — check for a hidden epic",
                 f["id"])

    for f in features:
        for d in f["depends_on"]:
            if d not in seen:
                errors.append(f"{f['id']}: depends_on unknown feature {d}")

    # id scheme: nag only if it is an exception, not if the catalog simply
    # predates this format
    mism = [f["id"] for f in features
            if f["block"]["area"] and len(f["id"][2:]) == 4
            and not f["id"][2:].startswith(f["block"]["area"])]
    if mism and len(mism) > len(features) // 5:
        print(f"note: this catalog does not use the F-<section><nn> id scheme "
              f"({len(mism)}/{len(features)} ids). That is fine for an existing "
              f"catalog — ids are permanent, so do NOT renumber. "
              f"`spec.py --area` falls back to section membership.")
    else:
        for i in mism:
            warn("id does not match its section number", i)

    for b in blocks:
        n = sum(1 for f in features if f["block"] is b)
        if n > MAX_ROWS_PER_BLOCK:
            warn(f"more than {MAX_ROWS_PER_BLOCK} feature rows — split the "
                 f"sub-area", f"{b['title']} ({n})")
        if b["lvl"] == 3 and (b["end"] - b["start"]) > MAX_BLOCK_LINES:
            warn(f"block over {MAX_BLOCK_LINES} lines — an agent must read all "
                 f"of it for one feature", f"{b['title']} ({b['end'] - b['start']})")

    for kind, subjects in sorted(soft.items()):
        head = ", ".join(subjects[:4])
        more = f" … +{len(subjects) - 4} more" if len(subjects) > 4 else ""
        warnings.append(f"{len(subjects):>3}x {kind}\n         {head}{more}")

    # coverage against the backlog
    if BACKLOG.exists():
        bl, dr = backlog_ids(), dropped_ids()
        uniq = set(by_id)                       # ids, not rows: a cross-referenced
        missing = sorted(uniq - bl - dr)        # id is one feature, not two
        ghost = sorted(g for g in bl - uniq - dr if re.fullmatch(r"F-\d{3,4}", g))
        print(f"coverage: {len(uniq) - len(missing)}/{len(uniq)} "
              f"catalog features are in the backlog or DROPPED.md")
        if missing:
            print(f"  not yet ingested ({len(missing)}): "
                  f"{' '.join(missing[:25])}{' …' if len(missing) > 25 else ''}")
        for g in ghost:
            errors.append(f"backlog cites {g}, which is not in the catalog "
                          f"and not in DROPPED.md")


def main() -> int:
    files = catalog_files()
    if not files:
        print(f"no catalog found at {FEATURES_DIR}/{GLOB}", file=sys.stderr)
        print("write one following docs/FEATURES-FORMAT.md", file=sys.stderr)
        return 2

    blocks, features = load_all()

    if "--check" in sys.argv:
        check(blocks, features)
        for w in warnings:
            print(f"WARN  {w}")
        for e in errors:
            print(f"ERROR {e}")
        print(f"\n{len(features)} features, {len(blocks)} blocks, "
              f"{len(errors)} error(s), {len(warnings)} warning(s)")
        return 1 if errors else 0

    n = write_manifest(blocks, features)
    print(f"wrote {MANIFEST.relative_to(ROOT)}  "
          f"({MANIFEST.stat().st_size} bytes)")
    print(f"{n} features across {len(blocks)} blocks in {len(files)} file(s)")
    print("run with --check to validate format and backlog coverage")
    return 0


if __name__ == "__main__":
    sys.exit(main())
