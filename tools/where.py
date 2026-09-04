#!/usr/bin/env python3
"""Resolve a vague, human sentence to the exact unit, doc and code path.

This is the addressing primitive. The user says "edit the profile button in the
panel" and never a path; this tool turns that into: unit, doc file, code file,
spec id, and the next commands to run.

It indexes, in priority order:
    docs/SURFACES.md        UI surface -> route -> unit -> component path
    docs/*/*/INDEX.md       unit front matter (id, keywords, source)
    docs/MASTER_INDEX.md    unit one-liners
    docs/BACKLOG.md         backlog rows
    docs/features/MANIFEST.md   feature ids + titles
    <code_roots>            filename fallback, only when the docs miss

usage:
    python3 tools/where.py "دکمه پروفایل تو پنل"
    python3 tools/where.py "profile button panel"
    python3 tools/where.py "refund" --json
    python3 tools/where.py --check          validate SURFACES.md against reality
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SURFACES = DOCS / "SURFACES.md"
MASTER = DOCS / "MASTER_INDEX.md"
BACKLOG = DOCS / "BACKLOG.md"
MANIFEST = DOCS / "features" / "MANIFEST.md"
UNIT_DIRS = ["domains", "interfaces", "platform"]

TOP_N = 6
DEFAULT_CODE_ROOTS = ["src", "app", "apps", "packages", "services"]

# words that carry no addressing information in either language
STOP = {
    "the", "a", "an", "in", "on", "of", "for", "to", "and", "or", "is", "it",
    "this", "that", "my", "our", "please", "can", "you", "i", "want", "need",
    "make", "do", "go", "at", "with", "from", "into",
    "تو", "توی", "در", "را", "رو", "از", "به", "که", "این", "اون", "آن", "با",
    "برای", "یه", "یک", "می", "میخوام", "میخام", "بکن", "کن", "بده", "لطفا",
    "هست", "است", "بود", "شود", "شه", "باید", "الان", "هم", "و", "یا", "ما",
    "من", "بشه", "کنی", "کنم", "چطور", "چطوری",
}

FIELD_WEIGHT = {          # where a token was found -> how much it counts
    "alias": 4,
    "name": 3,
    "unit": 3,
    "id": 3,
    "route": 2,
    "path": 2,
    "text": 1,
}
MAX_W = 4

# ---------------------------------------------------------------- normalising

_PERSIAN_FOLD = {
    "\u064a": "\u06cc",  # arabic yeh   -> farsi yeh
    "\u0649": "\u06cc",  # alef maksura -> farsi yeh
    "\u0643": "\u06a9",  # arabic kaf   -> farsi keheh
    "\u0629": "\u0647",  # teh marbuta  -> heh
    "\u0623": "\u0627", "\u0625": "\u0627", "\u0622": "\u0627",
    "\u200c": " ",       # ZWNJ is a word separator for our purposes
    "\u200f": " ", "\u200e": " ",
}
for _i, _d in enumerate("\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9"):
    _PERSIAN_FOLD[_d] = str(_i)
for _i, _d in enumerate("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669"):
    _PERSIAN_FOLD[_d] = str(_i)

_HARAKAT = re.compile(r"[\u064b-\u0652\u0670]")
_SPLIT = re.compile(r"[^0-9a-z\u0600-\u06ff]+")


def norm(s: str) -> str:
    s = (s or "").lower()
    s = "".join(_PERSIAN_FOLD.get(ch, ch) for ch in s)
    s = _HARAKAT.sub("", s)
    # camelCase / kebab / snake / path separators all become boundaries
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)
    return _SPLIT.sub(" ", s).strip()


def toks(s: str) -> list[str]:
    out = []
    for t in norm(s).split():
        if len(t) < 2 or t in STOP:
            continue
        if t not in out:
            out.append(t)
    return out


def hay(s: str) -> str:
    return " " + norm(s) + " "


# ------------------------------------------------------------------- parsing

def front_matter(path: Path) -> dict:
    """Tolerant YAML-ish reader. Handles `k: v`, `k: [a, b]` and `- item` lists."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return {}
    if not lines or lines[0].strip() != "---":
        return {}
    fm, key = {}, None
    for ln in lines[1:]:
        if ln.strip() == "---":
            break
        ln = ln.split("#")[0].rstrip() if not ln.strip().startswith("#") else ""
        if not ln.strip():
            continue
        if ln.lstrip().startswith("- ") and key:
            fm.setdefault(key, [])
            if isinstance(fm[key], list):
                fm[key].append(ln.lstrip()[2:].strip().strip("'\""))
            continue
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", ln)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            fm[key] = [x.strip().strip("'\"") for x in inner.split(",") if x.strip()]
        elif val == "":
            fm[key] = []
        else:
            fm[key] = val.strip("'\"")
    return fm


def md_rows(path: Path):
    """Yield dicts of every pipe table row, keyed by lowercased header cell."""
    if not path.exists():
        return
    header = None
    for ln in path.read_text(encoding="utf-8").splitlines():
        s = ln.strip()
        if not s.startswith("|"):
            header = None
            continue
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", s.strip("|"))]
        if set("".join(cells).replace(" ", "")) <= {"-", ":"} and cells:
            continue                                    # separator row
        if header is None:
            header = [norm(c).replace(" ", "_") or f"c{i}" for i, c in enumerate(cells)]
            continue
        row = {header[i]: cells[i] for i in range(min(len(header), len(cells)))}
        if any(v for v in row.values()):
            yield row


def strip_link(s: str) -> str:
    m = re.match(r"^\s*\[([^\]]*)\]\(([^)]*)\)\s*$", s or "")
    return m.group(2) if m else (s or "").strip()


def clean(s: str) -> str:
    s = re.sub(r"^\s*[_*`]+|[_*`]+\s*$", "", (s or "").strip())
    m = re.match(r"^\[([^\]]*)\]\([^)]*\)$", s)
    return (m.group(1) if m else s).strip()


def is_placeholder(row: dict) -> bool:
    blob = " ".join(row.values())
    return ("_example" in blob or "delete this row" in blob.lower()
            or blob.strip(" |_") == "")


def resolve_paths(patterns):
    """Glob a source: pattern list against the repo. Returns (existing, missing)."""
    found, missing = [], []
    for p in patterns or []:
        p = (p or "").strip()
        if not p:
            continue
        if any(c in p for c in "*?["):
            pats = [p, p[:-2] + "**/*"] if p.endswith("/**") else [p]
            raw = []
            for pat in pats:                  # `dir/**` yields folders only
                raw = sorted(ROOT.glob(pat))  # in pathlib; `dir/**/*` yields files
                if any(h.is_file() for h in raw):
                    break
            hits = [str(h.relative_to(ROOT)) for h in raw if h.is_file()]
            if not hits:                      # a glob that only matched folders
                hits = [str(h.relative_to(ROOT)) + "/" for h in raw if h.is_dir()]
        else:
            hits = [p] if (ROOT / p).exists() else []
        if hits:
            found.extend(hits[:8])
        else:
            missing.append(p)
    return found, missing


# ------------------------------------------------------------------ indexing

def code_roots() -> list[str]:
    fm = front_matter(SURFACES)
    roots = fm.get("code_roots") or []
    if isinstance(roots, str):
        roots = [roots]
    roots = [r for r in roots if (ROOT / r).is_dir()]
    return roots or [r for r in DEFAULT_CODE_ROOTS if (ROOT / r).is_dir()]


def load_surfaces() -> list[dict]:
    out = []
    for r in md_rows(SURFACES):
        if is_placeholder(r):
            continue
        name = clean(r.get("surface") or r.get("element") or r.get("screen") or "")
        if not name:
            continue
        out.append({
            "kind": "surface",
            "name": name,
            "unit": clean(r.get("unit", "")),
            "aliases": clean(r.get("aliases") or r.get("alias") or ""),
            "route": clean(r.get("route") or r.get("path_url") or ""),
            "code": clean(r.get("component") or r.get("code") or r.get("file") or ""),
            "spec": clean(r.get("spec_ref") or r.get("spec") or ""),
            "note": clean(r.get("note", "")),
        })
    return out


def load_units() -> list[dict]:
    out = {}
    for d in UNIT_DIRS:
        base = DOCS / d
        if not base.is_dir():
            continue
        for idx in sorted(base.rglob("INDEX.md")):
            fm = front_matter(idx)
            uid = fm.get("id")
            if not uid or uid.endswith("-index"):
                continue
            kw = fm.get("keywords") or fm.get("aliases") or []
            if isinstance(kw, str):
                kw = [kw]
            src = fm.get("source") or []
            if isinstance(src, str):
                src = [src]
            out[uid] = {
                "kind": "unit",
                "name": uid,
                "unit": uid,
                "aliases": " ".join(kw),
                "layer": fm.get("layer", d.rstrip("s")),
                "status": fm.get("status", "?"),
                "doc": str(idx.relative_to(ROOT)),
                "source": src,
                "text": "",
            }
    for r in md_rows(MASTER):
        if is_placeholder(r):
            continue
        uid = clean(r.get("id", ""))
        if not uid:
            continue
        desc = clean(r.get("one_line_responsibility") or r.get("responsibility")
                     or r.get("surface") or r.get("capability") or "")
        doc = strip_link(r.get("doc", ""))
        u = out.setdefault(uid, {"kind": "unit", "name": uid, "unit": uid,
                                 "aliases": "", "layer": "?", "status": "?",
                                 "doc": doc, "source": [], "text": ""})
        u["text"] = (u.get("text") or "") + " " + desc
        if doc and not u.get("doc"):
            u["doc"] = doc
        if clean(r.get("status", "")):
            u["status"] = clean(r["status"])
    return list(out.values())


def load_backlog() -> list[dict]:
    out = []
    for r in md_rows(BACKLOG):
        if is_placeholder(r):
            continue
        fid = clean(r.get("id", ""))
        feat = clean(r.get("feature") or r.get("question") or "")
        if not fid or not feat:
            continue
        out.append({
            "kind": "backlog", "name": fid, "unit": clean(r.get("unit", "")),
            "aliases": "", "text": feat, "status": clean(r.get("status", "")),
            "spec": clean(r.get("spec_ref", "")),
            "code": clean(r.get("proof_code_path") or r.get("proof") or ""),
        })
    return out


def load_features() -> list[dict]:
    out = []
    for r in md_rows(MANIFEST):
        fid = clean(r.get("id", ""))
        if not re.fullmatch(r"[Ff]-\d{3,4}", fid or ""):
            continue
        out.append({"kind": "feature", "name": fid, "unit": "",
                    "aliases": "", "text": clean(r.get("feature", "")),
                    "status": clean(r.get("status", "")),
                    "block": clean(r.get("block", ""))})
    return out


def scan_code(query_toks) -> list[dict]:
    """Last resort: match file *names* under the code roots. Never file contents."""
    hits = []
    skip = {"node_modules", ".git", "dist", "build", ".next", "__pycache__",
            "vendor", "target", ".venv", "coverage"}
    for root in code_roots():
        for p in (ROOT / root).rglob("*"):
            if not p.is_file() or p.suffix.lower() not in {
                    ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py",
                    ".go", ".rs", ".php", ".rb", ".java", ".kt", ".dart"}:
                continue
            if skip & set(p.parts):
                continue
            rel = str(p.relative_to(ROOT))
            h = hay(rel)
            score = sum(1 for t in query_toks if f" {t}" in h or t in h)
            if score:
                hits.append({"kind": "code", "name": rel, "unit": "",
                             "aliases": "", "text": "", "score": score,
                             "code": rel})
    hits.sort(key=lambda x: (-x["score"], len(x["name"])))
    return hits[:5]


# ------------------------------------------------------------------- scoring

def score(cand: dict, query_toks) -> tuple[int, list[str]]:
    fields = [
        ("alias", cand.get("aliases", "")),
        ("name", cand.get("name", "")),
        ("unit", cand.get("unit", "")),
        ("id", cand.get("spec", "")),
        ("route", cand.get("route", "")),
        ("path", " ".join(cand.get("source", [])) + " " + cand.get("code", "")),
        ("text", cand.get("text", "") + " " + cand.get("note", "")),
    ]
    hays = [(FIELD_WEIGHT[f], hay(v)) for f, v in fields if v]
    total, matched = 0, []
    for t in query_toks:
        best = 0
        for w, h in hays:
            if f" {t} " in h:
                best = max(best, w)
            elif t in h:                       # prefix / infix, e.g. profil^e
                best = max(best, w - 1)
        if best:
            total += best
            matched.append(t)
    if cand["kind"] == "surface":
        total = int(total * 1.15)              # a surface row is the sharpest hit
    return total, matched


# -------------------------------------------------------------------- output

def fmt(c: dict, q_toks) -> list[str]:
    L = []
    tag = {"surface": "SURFACE", "unit": "UNIT", "backlog": "BACKLOG",
           "feature": "FEATURE", "code": "CODE"}[c["kind"]]
    head = f"[{tag}] {c['name']}"
    if c.get("unit") and c["unit"] != c["name"]:
        head += f"   unit: {c['unit']}"
    if c.get("status"):
        head += f"   status: {c['status']}"
    L.append(head)
    if c.get("route"):
        L.append(f"    route   {c['route']}")
    if c.get("doc"):
        L.append(f"    doc     {c['doc']}")
    code = "" if c["kind"] == "code" else (c.get("code") or "")
    if code:
        found, missing = resolve_paths([code])
        for f in found:
            L.append(f"    code    {f}")
        for m in missing:
            L.append(f"    code    {m}   (!! path does not exist)")
    if c.get("source"):
        found, missing = resolve_paths(c["source"])
        for f in found[:4]:
            L.append(f"    code    {f}")
        if len(found) > 4:
            L.append(f"    code    … {len(found) - 4} more under {c['source'][0]}")
        for m in missing:
            L.append(f"    code    {m}   (!! nothing matches)")
        if not c["source"]:
            L.append("    code    — not implemented yet (empty source:)")
    if c.get("spec"):
        L.append(f"    spec    {c['spec']}   ->  python3 tools/spec.py {c['spec']}")
    if c.get("text"):
        L.append(f"    what    {c['text'][:96]}")
    if c.get("note"):
        L.append(f"    note    {c['note'][:96]}")
    return L


def next_steps(top: dict) -> list[str]:
    out = ["", "next:"]
    unit = top.get("unit") or (top["name"] if top["kind"] == "unit" else "")
    if unit:
        doc = top.get("doc")
        if not doc:
            for d in UNIT_DIRS:
                for cand in (DOCS / d).rglob("INDEX.md") if (DOCS / d).is_dir() else []:
                    if front_matter(cand).get("id") == unit:
                        doc = str(cand.relative_to(ROOT))
        if doc:
            out.append(f"  1. read {doc}  (tier 1), then its contract.md + invariants.md")
    if top.get("spec"):
        out.append(f"  2. python3 tools/spec.py {top['spec']}")
    out.append("  3. edit only the code paths above. Do not open docs/features/App-Features.md.")
    return out


# --------------------------------------------------------------------- check

def check() -> int:
    errs, warns = [], []
    if not SURFACES.exists():
        print("docs/SURFACES.md is missing — where.py can only guess without it.")
        return 1
    units = {u["name"] for u in load_units()}
    seen = set()
    rows = load_surfaces()
    for s in rows:
        n = s["name"]
        if n in seen:
            errs.append(f"duplicate surface id: {n}")
        seen.add(n)
        if not s["aliases"]:
            warns.append(f"{n}: no aliases — the user's own words will not match it")
        if s["unit"] and units and s["unit"] not in units:
            errs.append(f"{n}: unit '{s['unit']}' is not in MASTER_INDEX / unit docs")
        if s["code"]:
            found, missing = resolve_paths([s["code"]])
            if missing:
                errs.append(f"{n}: component path does not exist: {missing[0]}")
        else:
            warns.append(f"{n}: no component path — not addressable yet")
    print(f"surfaces: {len(rows)}   errors: {len(errs)}   warnings: {len(warns)}")
    for e in errs:
        print(f"  ERROR   {e}")
    for w in warns:
        print(f"  warn    {w}")
    return 1 if errs else 0


# ---------------------------------------------------------------------- main

def main() -> int:
    args = sys.argv[1:]
    if not args or "--help" in args or "-h" in args:
        print(__doc__)
        return 1
    if "--check" in args:
        return check()

    as_json = "--json" in args
    query = " ".join(a for a in args if not a.startswith("--"))
    q = toks(query)
    if not q:
        print("nothing to look for in that query.", file=sys.stderr)
        return 1

    cands = load_surfaces() + load_units() + load_backlog() + load_features()
    scored = []
    for c in cands:
        s, m = score(c, q)
        if s:
            c = dict(c, score=s, matched=m)
            scored.append(c)
    scored.sort(key=lambda c: (-c["score"], c["kind"] != "surface", c["name"]))

    ceiling = len(q) * MAX_W
    strong = [c for c in scored if c["score"] >= max(3, ceiling * 0.4)]
    shown = (strong or scored)[:TOP_N]

    weak = not shown or shown[0]["score"] < ceiling * 0.5
    if weak:
        extra = [c for c in scan_code(q)
                 if c["name"] not in {s.get("code") for s in shown}]
        for c in extra:                       # filename hits rank below any doc row
            c["score"] = min(c["score"], 2)
        shown = (shown + extra)[:TOP_N]

    if not shown:
        shown = scan_code(q)
        if shown:
            print(f'no doc row matches "{query}". Filename matches only — '
                  f"add a row to docs/SURFACES.md once you know the answer:\n")
        else:
            print(f'nothing matches "{query}".')
            print("  - if it is a UI thing, it is missing from docs/SURFACES.md")
            print("  - if it is a whole capability, it is missing from docs/MASTER_INDEX.md")
            print("  - ask the user which unit owns it. Do not guess a path.")
            return 2

    if as_json:
        print(json.dumps(shown, ensure_ascii=False, indent=2))
        return 0

    top = shown[0]
    second = shown[1]["score"] if len(shown) > 1 else 0
    confident = top.get("score", 0) >= max(4, second * 1.6)
    print(f'query: "{query}"   tokens: {" ".join(q)}')
    if confident:
        print("confident match\n")
        for ln in fmt(top, q):
            print(ln)
        print()
        rest = [c["name"] for c in shown[1:]]
        if rest:
            print(f"also considered (much weaker): {', '.join(rest)}\n")
        print("\n".join(next_steps(top)))
        return 0

    print(f"candidates — pick one, or ask the user   ({len(shown)} shown)\n")
    for c in shown:
        for ln in fmt(c, q):
            print(ln)
        print()
    print("next: name the candidate you chose out loud before touching code.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
