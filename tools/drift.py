#!/usr/bin/env python3
"""What changed in the code since the docs were last synced, and who owns it.

MODE: RECONCILE sweeps the whole tree and costs a session. This is the cheap
incremental version: you coded for a week without an agent, and now you want a
precise, small work order instead of a full re-derivation.

It reports. It writes nothing except the sync marker, and only when asked.

usage:
    python3 tools/drift.py                  report changes since docs/.sync
    python3 tools/drift.py --since <ref>    since an arbitrary git ref
    python3 tools/drift.py --update-marker  mark HEAD as synced (after fixing docs)
    python3 tools/drift.py --init           create docs/.sync at HEAD
"""
import importlib.util
import re
import signal
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
MARKER = DOCS / ".sync"
UNIT_DIRS = ["domains", "interfaces", "platform"]
CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".go",
            ".rs", ".php", ".rb", ".java", ".kt", ".dart", ".sql", ".prisma"}
SKIP_PARTS = {"node_modules", ".git", "dist", "build", ".next", "__pycache__",
              "vendor", "target", ".venv", "coverage", "docs", "tools"}

_spec = importlib.util.spec_from_file_location("where", Path(__file__).parent / "where.py")
W = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(W)


# ------------------------------------------------------------------ git glue

def git(*args, raw=False):
    try:
        r = subprocess.run(["git"] + list(args), cwd=ROOT,
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return None
        return r.stdout if raw else r.stdout.strip()
    except Exception:
        return None


def has_git() -> bool:
    return git("rev-parse", "--git-dir") is not None


def read_marker():
    if not MARKER.exists():
        return None, None
    ref = when = None
    for ln in MARKER.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(ref|date)\s*:\s*(\S+)", ln.strip())
        if m:
            if m.group(1) == "ref":
                ref = m.group(2)
            else:
                when = m.group(2)
    return ref, when


def write_marker(ref):
    MARKER.write_text(
        f"# Set by `python3 tools/drift.py --update-marker`. Commit this file.\n"
        f"# It records the last point at which docs and code were in agreement.\n"
        f"ref: {ref}\ndate: {date.today().isoformat()}\n", encoding="utf-8")


def changed_since(ref):
    """-> [(status, path)] where status is A/M/D/R."""
    out = git("diff", "--name-status", f"{ref}..HEAD")
    if out is None:
        return None
    rows = []
    for ln in out.splitlines():
        parts = ln.split("\t")
        if len(parts) < 2:
            continue
        st = parts[0][0]
        rows.append((st, parts[-1]))
    dirty = git("status", "--porcelain", raw=True) or ""
    for ln in dirty.splitlines():                 # uncommitted work counts too
        m = re.match(r"^(.{2})\s(.*)$", ln)
        if not m:
            continue
        code, p = m.group(1), m.group(2).strip().strip('"')
        p = p.split(" -> ")[-1]                   # renames: "old -> new"
        st = "D" if "D" in code else ("A" if "?" in code or "A" in code else "M")
        if p and (st, p) not in rows:
            rows.append((st, p))
    return rows


def scan_mtime(since_iso):
    """Fallback when there is no git: anything modified after the marker date."""
    try:
        cut = date.fromisoformat(since_iso)
    except Exception:
        return []
    rows = []
    for p in ROOT.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in CODE_EXT:
            continue
        if SKIP_PARTS & set(p.parts):
            continue
        if date.fromtimestamp(p.stat().st_mtime) >= cut:
            rows.append(("M", str(p.relative_to(ROOT))))
    return rows


# ------------------------------------------------------------------ matching

def glob_re(pattern: str):
    p = pattern.strip().rstrip("/")
    out, i = "", 0
    while i < len(p):
        c = p[i]
        if c == "*":
            if p[i:i + 2] == "**":
                out += ".*"
                i += 2
                if p[i:i + 1] == "/":
                    i += 1
                continue
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    if pattern.rstrip("/").endswith("**"):
        return re.compile("^" + out + "$")
    return re.compile("^" + out + "(/.*)?$")


def load_owners():
    """-> ([(unit, regex, raw)], [(surface, path, unit)])"""
    unit_pats, surfaces = [], []
    for u in W.load_units():
        for src in u.get("source") or []:
            if src.strip():
                unit_pats.append((u["name"], glob_re(src), src.strip()))
    for s in W.load_surfaces():
        if s.get("code"):
            surfaces.append((s["name"], s["code"], s.get("unit", "")))
    return unit_pats, surfaces


def owner_of(path, unit_pats):
    hits = [u for u, rx, _ in unit_pats if rx.match(path)]
    return hits[0] if hits else None


def owners_of(path, unit_pats):
    return sorted({u for u, rx, _ in unit_pats if rx.match(path)})


CODE_LAYOUT = DOCS / "CODE-LAYOUT.md"


def load_unit_aliases():
    """docs/CODE-LAYOUT.md can declare `unit_aliases: [unit:alias, ...]` for a
    codebase that predates the skeleton, where a unit's folder name doesn't
    spell out its id (`identity` under `auth/`, `i18n` under `i18n-platform/`).
    Renaming live code to satisfy this checker is not worth the blast radius,
    so an explicit, reviewed alias is the sanctioned escape hatch instead."""
    fm = W.front_matter(CODE_LAYOUT)
    aliases = {}
    for item in fm.get("unit_aliases") or []:
        if ":" not in item:
            continue
        u, alias = item.split(":", 1)
        aliases.setdefault(u.strip(), set()).add(alias.strip())
    return aliases


def broad_sources(unit_pats):
    """A source: glob that does not contain its own unit id (or a declared
    alias of it) breaks the mirror rule (docs/CODE-LAYOUT.md). Ownership then
    cannot be derived, and every orphan hides inside the over-broad glob
    instead of being reported."""
    aliases = load_unit_aliases()
    out = []
    for u, _, raw in unit_pats:
        segs = [s for s in raw.replace("*", "").split("/") if s]
        names = {u} | aliases.get(u, set())
        if not any(n == s or n in s.split(".") for s in segs for n in names):
            out.append((u, raw))
    return out


def is_code(path):
    p = Path(path)
    return p.suffix.lower() in CODE_EXT and not (SKIP_PARTS & set(p.parts))


# -------------------------------------------------------------------- report

def main() -> int:
    args = sys.argv[1:]

    if "--init" in args:
        ref = git("rev-parse", "HEAD") or "no-git"
        write_marker(ref)
        print(f"marker set: {ref[:12]} ({date.today()})")
        return 0

    if "--update-marker" in args:
        ref = git("rev-parse", "HEAD") or "no-git"
        write_marker(ref)
        print(f"marker moved to {ref[:12]}. Docs and code are declared in "
              f"agreement as of today.")
        return 0

    ref, when = read_marker()
    if "--since" in args:
        ref = args[args.index("--since") + 1]
    if not ref:
        print("no docs/.sync marker. Run `python3 tools/drift.py --init` at the "
              "point where docs and code agree, then again after you have "
              "coded.\nUntil then, MODE: RECONCILE is the right tool, not this "
              "one.")
        return 2

    if has_git() and ref != "no-git":
        rows = changed_since(ref)
        source = f"git {ref[:12]}..HEAD"
    else:
        rows = scan_mtime(when or "1970-01-01")
        source = f"file mtimes since {when} (no git — less reliable)"
    if rows is None:
        print(f"git could not diff against '{ref}'. Is the ref still valid?")
        return 2

    unit_pats, surfaces = load_owners()
    surf_by_path = {p: (n, u) for n, p, u in surfaces}

    by_unit, orphans, broken, new_ui = {}, [], [], []
    for st, path in rows:
        if not is_code(path):
            continue
        if st == "D":
            u = owner_of(path, unit_pats)
            if u:
                broken.append((f"unit {u}", path))
            if path in surf_by_path:
                broken.append((f"surface {surf_by_path[path][0]}", path))
            continue
        u = owner_of(path, unit_pats)
        if u:
            by_unit.setdefault(u, {"A": [], "M": []}).setdefault(
                "A" if st in "AR" else "M", []).append(path)
        else:
            orphans.append((st, path))
        if st in "AR" and path not in surf_by_path:
            if re.search(r"(page|screen|view|form|button|modal|dialog|card)",
                         Path(path).stem, re.I):
                new_ui.append(path)

    # docs pointing at files that no longer exist at all
    for u in W.load_units():
        for src in u.get("source") or []:
            found, missing = W.resolve_paths([src])
            for m in missing:
                broken.append((f"unit {u['name']} source:", m))
    for n, p, _ in surfaces:
        found, missing = W.resolve_paths([p])
        for m in missing:
            broken.append((f"surface {n} component:", m))

    spec_ids = {}
    if has_git() and ref != "no-git":
        log = git("log", "--format=%H%x00%B%x00", f"{ref}..HEAD") or ""
        for chunk in log.split("\x00\x00"):
            for fid in re.findall(r"\b[Ff]-\d{3,4}\b", chunk):
                spec_ids[fid.upper()] = spec_ids.get(fid.upper(), 0) + 1

    broad = broad_sources(unit_pats)
    contested = sorted({
        (p, tuple(owners_of(p, unit_pats)))
        for st, p in rows if is_code(p) and st != "D"
        and len(owners_of(p, unit_pats)) > 1})

    n_files = sum(1 for st, p in rows if is_code(p))
    print(f"SYNC REPORT   {source}")
    print(f"{n_files} code files changed\n")

    if by_unit:
        print("UNITS TOUCHED — check source:, status, and the INDEX changelog")
        for u in sorted(by_unit):
            d = by_unit[u]
            doc = next((x["doc"] for x in W.load_units() if x["name"] == u), "?")
            print(f"  {u:16} {len(d['M']):>3} modified  {len(d['A']):>3} new     {doc}")
        print()

    if orphans:
        print("ORPHANS — code that no unit's source: claims.")
        print("  This is the finding that matters. Each one is either a new unit,")
        print("  or it belongs inside an existing one. ASK — do not decide alone.")
        seen = set()
        for st, p in sorted(orphans):
            folder = str(Path(p).parent)
            if folder in seen:
                continue
            seen.add(folder)
            n = sum(1 for s2, p2 in orphans if str(Path(p2).parent) == folder)
            print(f"    {folder}/    ({n} file(s))")
        print()

    if broad or contested:
        print("AMBIGUOUS OWNERSHIP — fix this first; it hides everything else")
        for u, raw in broad:
            print(f"    unit {u}: source: `{raw}` does not contain the unit id.")
            print(f"      The mirror rule is broken, so this glob silently "
                  f"claims other units' code")
            print(f"      and any orphan inside it. Narrow it to "
                  f".../{u}/** before trusting this report.")
        for p2, owners in contested:
            print(f"    {p2}")
            print(f"      claimed by {', '.join(owners)} — exactly one unit "
                  f"owns a file")
        print()

    if broken:
        print("BROKEN REFERENCES — docs point at files that are gone")
        for who, p in sorted(set(broken)):
            print(f"    {who:34} {p}")
        print()

    if new_ui:
        print("LIKELY NEW SURFACES — user-visible files with no SURFACES.md row")
        for p in sorted(set(new_ui)):
            print(f"    {p}")
        print("  Without a row, the next session has to grep to find these.\n")

    if spec_ids:
        print("SPEC IDS CITED IN COMMITS — candidate backlog rows to verify")
        for fid, n in sorted(spec_ids.items()):
            print(f"    {fid}  ({n} commit(s))")
        print("  Verify each against the code. A commit message is a claim, "
              "not proof.\n")

    if not (by_unit or orphans or broken or new_ui or broad or contested):
        print("nothing to sync — no code changed since the marker.")
        return 0

    print("Next: run MODE: SYNC (docs/00-PROTOCOL.md §6f). Fix the docs, then")
    print("      python3 tools/drift.py --update-marker")
    return 0


if __name__ == "__main__":
    try:                                          # tolerate `| head`
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    except (AttributeError, ValueError):
        pass
    sys.exit(main())
