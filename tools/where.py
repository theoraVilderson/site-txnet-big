#!/usr/bin/env python3
"""Resolve a human sentence to a unit, a file — or an ordered path through units.

Two questions, two answers:

    "edit the profile button in the panel"   -> one place.        LOCATE
    "cookie login doesn't work"              -> a path to walk.   WALK

LOCATE is the v3.2 behaviour, fixed: a surface row now *dominates* the unit it
points at instead of tying with it, so a good row produces `confident match`
instead of a shortlist nobody trusts.

WALK is new. A bug report names a symptom, not a location, and the answer is a
chain: panel -> auth -> session. That chain already exists in `depends_on` plus
the runtime edges in `docs/architecture/dependency-graph.md`; this tool walks it
instead of scoring its members against each other.

It indexes, in priority order:
    docs/SURFACES.md            ## Flows    cached paths, written after a fix
    docs/SURFACES.md            surface -> route -> unit -> component
    docs/*/*/INDEX.md           unit front matter (id, keywords, source, depends_on)
    docs/architecture/dependency-graph.md   runtime edges (queue/webhook/cron)
    docs/MASTER_INDEX.md        unit one-liners
    docs/BACKLOG.md             backlog rows
    docs/features/MANIFEST.md   feature ids + titles
    <code_roots>                filename fallback, only when the docs miss

usage:
    python3 tools/where.py "دکمه پروفایل تو پنل"
    python3 tools/where.py "profile button panel"
    python3 tools/where.py --walk "cookie login doesn't work"
    python3 tools/where.py --check                 validate, and fail on an open miss
    python3 tools/where.py --misses                show the miss queue
    python3 tools/where.py --resolve "<query>"     close a miss once the row exists
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SURFACES = DOCS / "SURFACES.md"
MASTER = DOCS / "MASTER_INDEX.md"
BACKLOG = DOCS / "BACKLOG.md"
MANIFEST = DOCS / "features" / "MANIFEST.md"
DEPGRAPH = DOCS / "architecture" / "dependency-graph.md"
MISSES = DOCS / ".where-misses"
UNIT_DIRS = ["domains", "interfaces", "platform"]

TOP_N = 6
MAX_HOPS = 3                  # §3c budget. pairs with the protocol's 8-file ceiling.
DEFAULT_CODE_ROOTS = ["src", "app", "apps", "packages", "services"]

MISS_HEADER = (
    "# queries that found nothing. close each one by adding a SURFACES.md row,\n"
    "# then: python3 tools/where.py --resolve \"<query>\"\n"
    "# date\tstatus\tquery\n")

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

# A symptom word says nothing about *where* — only about what broke. It must
# never steer the entry point, only the order the frontier is walked in.
SYMPTOM = {
    "broken", "break", "breaks", "fail", "fails", "failing", "error", "errors",
    "bug", "wrong", "work", "works", "working", "doesn", "dont", "not", "no",
    "crash", "crashes", "hang", "hangs", "slow", "stuck", "missing", "empty",
    "null", "undefined", "timeout", "500", "401", "403", "404",
    "خراب", "کار", "نمیکنه", "نمیکند", "نمی", "کنه", "مشکل", "ارور", "خطا",
    "باگ", "غلط", "اشتباه", "خالی", "کند", "گیر", "قطع", "نمیاد", "نمیشه",
    "درست", "نمیشود",
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
    s = s or ""
    # camelCase must split before lowercasing destroys the boundary
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s).lower()
    s = "".join(_PERSIAN_FOLD.get(ch, ch) for ch in s)
    s = _HARAKAT.sub("", s)
    return _SPLIT.sub(" ", s).strip()


def toks(s: str) -> list[str]:
    out = []
    for t in norm(s).split():
        if len(t) < 2 or t in STOP:
            continue
        if t not in out:
            out.append(t)
    return out


def split_query(q_toks):
    """Strip the symptom words. What is left is the addressing half."""
    return [t for t in q_toks if t not in SYMPTOM], [t for t in q_toks if t in SYMPTOM]


def hypothesis_of(q_toks, top: dict) -> list[str]:
    """The tokens the entry point did NOT explain.

    Deciding this from a word list would be guesswork — `cookie` is not a
    symptom word, and in another project it could well be the name of a unit.
    So let the data decide: whatever the winning row already accounts for is the
    locator; every other meaningful token is the user's theory about the cause.

    A theory that reorders the walk is useful even when wrong. A theory that
    picks the entry point is a wrong turn taken confidently — which is why this
    runs *after* the entry point is chosen, never before.
    """
    explained = set(top.get("matched") or [])
    return [t for t in q_toks if t not in explained and t not in SYMPTOM]


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


def md_rows(path: Path, section: str = None):
    """Yield dicts of every pipe table row, keyed by lowercased header cell.

    `section` limits the scan to rows under a `## <section>` heading.
    """
    if not path.exists():
        return
    header = None
    in_section = section is None
    for ln in path.read_text(encoding="utf-8").splitlines():
        s = ln.strip()
        if s.startswith("#"):
            if section is not None:
                in_section = norm(s.lstrip("# ")).startswith(norm(section))
            header = None
            continue
        if not s.startswith("|"):
            header = None
            continue
        if not in_section:
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


def load_flows() -> list[dict]:
    """Cached paths. A flow row is written *after* a walk, never guessed."""
    out = []
    for r in md_rows(SURFACES, section="Flows"):
        if is_placeholder(r):
            continue
        name = clean(r.get("flow") or "")
        if not name:
            continue
        path = [p.strip() for p in re.split(r"[->→,]+", clean(r.get("path", "")))
                if p.strip()]
        out.append({
            "kind": "flow",
            "name": name,
            "unit": path[0] if path else clean(r.get("entry", "")),
            "aliases": clean(r.get("aliases") or ""),
            "path": path,
            "code": clean(r.get("files") or r.get("file") or ""),
            "spec": clean(r.get("spec_ref") or r.get("spec") or ""),
            "note": clean(r.get("note", "")),
        })
    return out


def load_surfaces() -> list[dict]:
    out = []
    for r in md_rows(SURFACES):
        if is_placeholder(r) or "flow" in r:
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
            if "_TEMPLATE" in str(idx):
                continue
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
            dep = fm.get("depends_on") or []
            if isinstance(dep, str):
                dep = [dep]
            out[uid] = {
                "kind": "unit",
                "name": uid,
                "unit": uid,
                "aliases": " ".join(kw),
                "layer": fm.get("layer", d.rstrip("s")),
                "status": fm.get("status", "?"),
                "doc": str(idx.relative_to(ROOT)),
                "source": src,
                "depends_on": dep,
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
                                 "doc": doc, "source": [], "depends_on": [],
                                 "text": ""})
        u["text"] = (u.get("text") or "") + " " + desc
        if doc and not u.get("doc"):
            u["doc"] = doc
        if clean(r.get("status", "")):
            u["status"] = clean(r["status"])
    return list(out.values())


def load_runtime_edges() -> list[dict]:
    """Async edges `depends_on` cannot see: queues, webhooks, cron.

    Kept as a separate edge type on purpose. `depends_on` answers "who do I
    call" and drives §8 blast radius; a runtime edge answers "what runs after
    me" and drives the walk. Merging them would inflate every consumer list and
    make every contract change look breaking.
    """
    out = []
    for r in md_rows(DEPGRAPH, section="Runtime edges"):
        if is_placeholder(r):
            continue
        src, dst = clean(r.get("from", "")), clean(r.get("to", ""))
        if not src or not dst:
            continue
        out.append({"from": src, "to": dst,
                    "via": clean(r.get("via", "")) or "runtime",
                    "why": clean(r.get("why", ""))})
    return out


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
            sc = sum(1 for t in query_toks if f" {t}" in h or t in h)
            if sc:
                hits.append({"kind": "code", "name": rel, "unit": "",
                             "aliases": "", "text": "", "score": sc,
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
    if cand["kind"] == "flow":
        total = int(total * 1.4)               # a cached path beats deriving one
    elif cand["kind"] == "surface":
        total = int(total * 1.15)
    return total, matched


def dominate(scored: list[dict]) -> list[dict]:
    """A surface row outranks the unit it points at — it does not tie with it.

    README step 6 asks you to fill both a surface's `aliases` and its unit's
    `keywords` with the words you would actually say. That guarantees the two
    score alike, which is why v3.2 almost never reached `confident match`. The
    unit is still reachable — through the surface, which is strictly more
    specific — so drop it from the shortlist rather than let it compete.
    """
    owned = {c["unit"] for c in scored
             if c["kind"] in ("surface", "flow") and c.get("unit")}
    for c in scored:
        if c["kind"] == "flow":
            owned.update(c.get("path", []))
    return [c for c in scored if not (c["kind"] == "unit" and c["name"] in owned)]


# ---------------------------------------------------------------- miss queue

def load_misses() -> list[dict]:
    if not MISSES.exists():
        return []
    out = []
    for ln in MISSES.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        parts = ln.split("\t")
        if len(parts) >= 3:
            out.append({"date": parts[0], "status": parts[1], "query": parts[2]})
    return out


def log_miss(query: str) -> None:
    """A miss is a work item, not a warning.

    `where.py --check` is already in the pre-flight list and fails while an
    entry is open, so the row gets added before anything can be called done —
    without ever interrupting the task that hit the miss.
    """
    rows = load_misses()
    if any(r["query"] == query and r["status"] == "open" for r in rows):
        return
    header = "" if MISSES.exists() else MISS_HEADER
    with MISSES.open("a", encoding="utf-8") as f:
        f.write(header + f"{date.today().isoformat()}\topen\t{query}\n")


def resolve_miss(query: str) -> int:
    rows = load_misses()
    if not rows:
        print("no misses recorded.")
        return 0
    hit = False
    for r in rows:
        if r["status"] == "open" and (r["query"] == query
                                      or norm(query) in norm(r["query"])):
            r["status"] = "closed"
            hit = True
    MISSES.write_text(
        MISS_HEADER + "".join(
            f"{r['date']}\t{r['status']}\t{r['query']}\n" for r in rows),
        encoding="utf-8")
    print(f"{'closed' if hit else 'no open miss matched'}: {query}")
    return 0 if hit else 1


# --------------------------------------------------------------------- walk

def build_graph(units):
    by_id = {u["name"]: u for u in units}
    edges = {}
    for u in units:
        for d in u.get("depends_on") or []:
            edges.setdefault(u["name"], []).append((d, "depends_on", ""))
    for e in load_runtime_edges():
        edges.setdefault(e["from"], []).append((e["to"], e["via"], e["why"]))
    return by_id, edges


def walk(entry: str, hypothesis, units, max_hops=MAX_HOPS):
    """BFS from the entry unit, frontier ordered by the user's hypothesis.

    The hypothesis never chooses the entry point — it only decides which
    neighbour to open first. A wrong guess then costs an ordering, not a
    session.
    """
    by_id, edges = build_graph(units)
    if entry not in by_id:
        return []
    plan, seen, frontier = [], {entry}, [(entry, "entry", "", 0)]
    while frontier:
        node, via, why, depth = frontier.pop(0)
        u = by_id.get(node, {})
        plan.append({"unit": node, "via": via, "why": why, "depth": depth,
                     "doc": u.get("doc", ""), "source": u.get("source", []),
                     "status": u.get("status", "?"), "layer": u.get("layer", "?")})
        if depth >= max_hops:
            continue
        nxt = []
        for dst, v, w in edges.get(node, []):
            if dst in seen:
                continue
            seen.add(dst)
            n = by_id.get(dst, {})
            h = hay(n.get("aliases", "") + " " + dst + " "
                    + " ".join(n.get("source", [])))
            rank = sum(1 for t in hypothesis if t in h)
            nxt.append((rank, dst, v, w))
        nxt.sort(key=lambda x: -x[0])
        frontier.extend((d, v, w, depth + 1) for _, d, v, w in nxt)
    return plan


# -------------------------------------------------------------------- output

def fmt(c: dict, q_toks) -> list[str]:
    L = []
    tag = {"flow": "FLOW", "surface": "SURFACE", "unit": "UNIT",
           "backlog": "BACKLOG", "feature": "FEATURE", "code": "CODE"}[c["kind"]]
    head = f"[{tag}] {c['name']}"
    if c.get("unit") and c["unit"] != c["name"]:
        head += f"   unit: {c['unit']}"
    if c.get("status"):
        head += f"   status: {c['status']}"
    L.append(head)
    if c.get("path"):
        L.append(f"    path    {' -> '.join(c['path'])}")
    if c.get("route"):
        L.append(f"    route   {c['route']}")
    if c.get("doc"):
        L.append(f"    doc     {c['doc']}")
    code = "" if c["kind"] == "code" else (c.get("code") or "")
    if code:
        for part in [p.strip() for p in code.split(",") if p.strip()]:
            found, missing = resolve_paths([part])
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


def print_walk(query, entry_cand, plan, hypothesis, cached=False):
    print(f'query: "{query}"')
    if cached:
        print("cached flow — this path was recorded by an earlier fix\n")
    else:
        print(f"walk plan   entry: {entry_cand['name']}   "
              f"hypothesis: {' '.join(hypothesis) or '—'}\n")
    for i, h in enumerate(plan):
        via = "entry point" if h["via"] == "entry" else f"via {h['via']}"
        line = f"  hop {i}   {h['unit']}   ({h.get('layer') or '?'}, {via})"
        if h.get("why"):
            line += f"   — {h['why']}"
        print(line)
        if h.get("doc"):
            print(f"           doc  {h['doc']}")
        found, missing = resolve_paths(h.get("source", []))
        for f in found[:3]:
            print(f"           code {f}")
        if len(found) > 3:
            print(f"           code … {len(found) - 3} more")
        for m in missing:
            print(f"           code {m}   (!! nothing matches)")
    print()
    if cached:
        print("This path is already known — do not re-derive it. Confirm the note")
        print("still describes the symptom, then go straight to the files above.")
        print("If the symptom is different this time, walk it fresh:")
        print(f'  python3 tools/where.py --walk "<their words>"  (and add a new flow row)')
        return
    print("rules for this walk (00-PROTOCOL.md §3c):")
    print(f"  - budget: {MAX_HOPS} hops, 8 files. State what you expect to find")
    print("    BEFORE opening each hop. A hop you cannot predict is a hop you")
    print("    are not ready to take — say so and stop.")
    print("  - narrow inside a unit with the symptom -> role table in")
    print("    docs/CODE-LAYOUT.md. Never read a whole unit.")
    print("  - code no unit claims: report it, do not adopt it. MODE: SYNC (§6f).")
    print("  - once fixed, record the path you actually took as a Flows row in")
    print("    docs/SURFACES.md, with the user's own sentence as aliases.")


# --------------------------------------------------------------------- check

def check() -> int:
    errs, warns = [], []
    if not SURFACES.exists():
        print("docs/SURFACES.md is missing — where.py can only guess without it.")
        return 1
    units = {u["name"] for u in load_units()}
    seen = set()
    rows = load_surfaces()
    flows = load_flows()
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
    for f in flows:
        if not f["aliases"]:
            warns.append(f"flow {f['name']}: no aliases — it will never be found again")
        for u in f["path"]:
            if units and u not in units:
                errs.append(f"flow {f['name']}: '{u}' in path is not a known unit")
        for part in [p.strip() for p in f["code"].split(",") if p.strip()]:
            _, missing = resolve_paths([part])
            if missing:
                errs.append(f"flow {f['name']}: file does not exist: {missing[0]}")

    open_misses = [m for m in load_misses() if m["status"] == "open"]
    for m in open_misses:
        errs.append(f'unresolved miss ({m["date"]}): "{m["query"]}" — add the row, '
                    f'then: python3 tools/where.py --resolve "{m["query"]}"')

    print(f"surfaces: {len(rows)}   flows: {len(flows)}   "
          f"open misses: {len(open_misses)}   "
          f"errors: {len(errs)}   warnings: {len(warns)}")
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
    if "--misses" in args:
        rows = load_misses()
        if not rows:
            print("no misses recorded.")
            return 0
        for r in rows:
            print(f"{r['status']:8} {r['date']}  {r['query']}")
        return 0
    if "--resolve" in args:
        return resolve_miss(" ".join(a for a in args if not a.startswith("--")))

    as_json = "--json" in args
    want_walk = "--walk" in args
    query = " ".join(a for a in args if not a.startswith("--"))
    q = toks(query)
    if not q:
        print("nothing to look for in that query.", file=sys.stderr)
        return 1
    locator, symptom = split_query(q)
    if not locator:
        locator = q

    units = load_units()
    cands = load_flows() + load_surfaces() + units + load_backlog() + load_features()
    scored = []
    for c in cands:
        s, m = score(c, locator)
        if s:
            scored.append(dict(c, score=s, matched=m))
    scored = dominate(scored)
    scored.sort(key=lambda c: (-c["score"],
                               c["kind"] not in ("flow", "surface"), c["name"]))

    ceiling = len(locator) * MAX_W
    strong = [c for c in scored if c["score"] >= max(3, ceiling * 0.4)]
    shown = (strong or scored)[:TOP_N]

    weak = not shown or shown[0]["score"] < ceiling * 0.5
    if weak:
        extra = [c for c in scan_code(locator)
                 if c["name"] not in {s.get("code") for s in shown}]
        for c in extra:                       # filename hits rank below any doc row
            c["score"] = min(c["score"], 2)
        shown = (shown + extra)[:TOP_N]

    if not shown:
        log_miss(query)
        shown = scan_code(locator)
        if shown:
            print(f'no doc row matches "{query}". Filename matches only — '
                  f"logged to docs/.where-misses:\n")
        else:
            print(f'nothing matches "{query}".  (logged to docs/.where-misses)')
            print("  - if it is a UI thing, it is missing from docs/SURFACES.md")
            print("  - if it is a whole capability, it is missing from docs/MASTER_INDEX.md")
            print("  - do NOT guess a path. Walk from the closest surface you do")
            print("    have, or ask the user to point at it once.")
            return 2

    if as_json:
        print(json.dumps(shown, ensure_ascii=False, indent=2))
        return 0

    top = shown[0]
    second = shown[1]["score"] if len(shown) > 1 else 0
    confident = top.get("score", 0) >= max(4, second * 1.6)
    hypothesis = hypothesis_of(q, top)

    # ---- walk mode: a symptom was named, or the caller asked for one
    if want_walk or ((symptom or hypothesis)
                     and top["kind"] in ("flow", "surface", "unit")):
        # A cache hit must be a *repeat*, not a keyword overlap. One shared word
        # ("login") between two unrelated symptoms is not the same bug, and
        # serving a stale path for a new problem is worse than deriving one:
        # it hands over an answer that looks confirmed. Demand most of the
        # sentence, and fall through to a fresh walk otherwise.
        cached_hit = (top["kind"] == "flow"
                      and len(top.get("matched") or []) >= 2
                      and top["score"] >= ceiling * 0.6)
        if cached_hit:
            by_id = {u["name"]: u for u in units}
            print_walk(query, top,
                       [{"unit": u, "via": "flow", "why": "", "depth": i,
                         "doc": by_id.get(u, {}).get("doc", ""),
                         "source": by_id.get(u, {}).get("source", []),
                         "status": by_id.get(u, {}).get("status", ""),
                         "layer": by_id.get(u, {}).get("layer", "?")}
                        for i, u in enumerate(top["path"])],
                       hypothesis, cached=True)
            print()
            for ln in fmt(top, q):
                print(ln)
            return 0
        plan = walk(top.get("unit") or top["name"], hypothesis, units)
        if plan:
            print_walk(query, top, plan, hypothesis)
            return 0

    print(f'query: "{query}"   locator: {" ".join(locator)}'
          + (f'   hypothesis: {" ".join(hypothesis)}' if hypothesis else ""))
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
