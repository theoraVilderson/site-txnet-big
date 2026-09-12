#!/usr/bin/env python3
"""Mechanically enforce docs/00-PROTOCOL.md. No dependencies. Exit 1 on failure.

Checks:
  1. every unit file has valid front matter with the required keys
  2. INDEX.md <= 40 lines; contract.md and each contract.<topic>.md <= 250 lines
  3. status: active implies a non-empty `source:` whose paths exist
  4. depends_on points at real unit ids  (and derives the consumer map)
  5. ASSUMED(YYYY-MM-DD) tags older than MAX_AGE_DAYS
  6. open-questions rows without a date
  7. every unit is reachable from MASTER_INDEX.md
  8. every path a doc *claims* points at real code actually exists
"""
import os
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
MAX_CHANGELOG_ROWS = 5

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
    pending = text[3:end].splitlines()
    while pending:
        line = pending.pop(0)
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
        # A `[a, b, c]` list that wraps onto the next line used to fall through
        # to the plain-string branch and then get iterated character by
        # character. Wrapping is exactly what you do once a list is long, which
        # is exactly what happens in a large project — so the failure was
        # reserved for the units that could least afford it.
        if val.startswith("[") and not val.endswith("]"):
            depth, buf = 1, val
            while depth and pending:
                nxt = pending.pop(0)
                buf += " " + nxt.strip()
                depth += nxt.count("[") - nxt.count("]")
            val = buf
            if not val.endswith("]"):
                fm[key] = []
                continue
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            fm[key] = [v.strip() for v in inner.split(",") if v.strip()]
        elif val == "":
            fm[key] = []
        else:
            fm[key] = val
    return fm


def body_lines(path: Path) -> int:
    """Lines after the front matter.

    The 40-line cap exists so an INDEX stays a router rather than growing
    content. Front matter is neither: it is mandatory metadata whose length is
    set by how many things the unit legitimately depends on, owns and exposes.
    Counting it against the cap meant a mature unit hit the ceiling with an
    empty body, and the only remaining lever — the changelog — was already at
    its own cap. Two mandatory rules then contradicted each other, with no legal
    move left. Cap the body; let the metadata be as long as the unit is real.
    """
    text = path.read_text(encoding="utf-8")
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:]
    return len(text.splitlines())


def unit_dirs():
    for layer in UNIT_LAYERS:
        base = DOCS / layer
        if not base.exists():
            continue
        for idx in base.rglob("INDEX.md"):
            if idx.parent == base:
                continue  # the layer's own INDEX, not a unit
            yield idx.parent


# --- 8. a claimed path must exist -------------------------------------------
#
# Check 3 validates a unit's `source:`, which is the only place the protocol
# names. Three other columns make the same claim — "this path is the code" — and
# nothing checked them, so they rotted silently:
#
#   * `BACKLOG.md` `proof` — F-016 cited a file deleted a week earlier, while
#     the row read `done`. `done` means the code exists; the proof is the whole
#     evidence for that, so a broken one makes the status unverifiable.
#   * `SURFACES.md` `component` — `where.py --check` already covers this one.
#   * `CODE-LAYOUT.md`'s tables — the symptom -> role table sent a DIAGNOSE
#     session to `site-pwa/src/app/api/auth/[...path]/route.ts`, removed on
#     2026-09-05. A wrong file opened confidently is the expensive failure §3c
#     exists to prevent.
#
# Prose is deliberately **not** checked. A contract's Deprecations table names
# removed files on purpose, and `MIGRATION.md` names scaffolding it also tells
# you to delete — both are correct, and flagging them would teach the reader to
# ignore this check.

# Reject a glob, a brace expansion, a placeholder or an ellipsis: those are
# patterns, and a pattern is not a claim about one file.
PATH_REJECT = re.compile(r"[*{}<>$\s]|\.\.\.|…")
PATH_SHAPE = re.compile(r"^[\w./@()\[\]-]+$")


def claimed_paths(cell: str):
    """The substrings of one table cell that assert a real file, unescaped."""
    out = []
    for raw in re.split(r"[,\s]+", cell.replace("\\_", "_")):
        cand = raw.strip().strip("`\"'").rstrip(".,;:)")
        if not cand or "/" not in cand or cand.startswith(("http", "#")):
            continue
        if PATH_REJECT.search(cand) or not PATH_SHAPE.match(cand):
            continue
        if not (re.search(r"\.[a-z0-9]+$", cand) or cand.endswith("/")):
            continue
        # A bare one-word directory (`dist/`, `src/`) is a fragment in a
        # sentence, not an address — two segments is the floor for a claim.
        if cand.endswith("/") and cand.strip("/").count("/") == 0:
            continue
        out.append(cand)
    return out


_PATH_INDEX = None
_INDEX_SKIP = {".git", "node_modules", "dist", ".next", "__pycache__", ".nx",
               "coverage", "venv", ".venv"}


def path_index():
    """Every file and directory in the repo, repo-relative, walked once."""
    global _PATH_INDEX
    if _PATH_INDEX is None:
        out = set()
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in _INDEX_SKIP]
            base = Path(dirpath)
            for name in dirnames:
                out.add(str((base / name).relative_to(ROOT)) + "/")
            for name in filenames:
                out.add(str((base / name).relative_to(ROOT)))
        _PATH_INDEX = out
    return _PATH_INDEX


def resolve_claim(cand: str):
    """-> the path it names, or None.

    Matched as a **suffix**, not only from the repo root, because that is the
    convention these tables already use: `CODE-LAYOUT.md` says to look in
    `session/chat-access.ts` and `automation/schedule.ts`, which are
    `bot-service/src/app/…` and `shared-core/src/lib/…`. Requiring full paths
    would have made this a checker that silently skipped every row of the one
    table it was written for — the failure it exists to catch.

    A suffix match is deliberately weaker than an exact one: it answers "does
    this name anything at all", not "is this the right file". That is the
    question here. A path pointing at nothing is the bug (F-016's proof, and
    the removed auth proxy this table named for a week); a path that is merely
    imprecise is a reader's problem, not a checker's.
    """
    if cand in path_index() or (ROOT / cand).exists():
        return cand
    needle = "/" + cand.rstrip("/") + ("/" if cand.endswith("/") else "")
    for known in path_index():
        if known.endswith(needle):
            return known
    return None


def check_claimed_paths():
    """Rows in the three files whose columns claim a path points at real code."""
    # (file, which cell index holds the claim, which cell identifies the row)
    sites = [
        ("docs/BACKLOG.md", 6, 0),
        ("docs/SURFACES.md", 4, 0),
    ]
    for rel, col, key in sites:
        f = ROOT / rel
        if not f.exists():
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) <= col or cells[0].startswith(("-", "id", "surface")):
                continue
            if "(removed)" in line:
                continue  # a row that documents something gone, on purpose
            for cand in claimed_paths(cells[col]):
                if resolve_claim(cand) is None:
                    errors.append(
                        f"{rel}: {cells[key]} claims `{cand}`, which does not exist. "
                        f"A `done` row proven by a missing file is a status nobody "
                        f"can verify — repoint it or say where the code went")

    # CODE-LAYOUT's tables are prose-heavy, so only backticked candidates count.
    layout = ROOT / "docs/CODE-LAYOUT.md"
    if layout.exists():
        for n, line in enumerate(layout.read_text(encoding="utf-8").splitlines(), 1):
            if not line.startswith("|") or "(removed)" in line:
                continue
            for quoted in re.findall(r"`([^`]+)`", line):
                for cand in claimed_paths(quoted):
                    if resolve_claim(cand) is None:
                        errors.append(
                            f"docs/CODE-LAYOUT.md:{n}: names `{cand}`, which does not "
                            f"exist — this table is what a DIAGNOSE session opens first")


def main() -> int:
    units, tmpl = {}, re.compile(r"_TEMPLATE")

    groups = set()
    for d in unit_dirs():
        if tmpl.search(str(d)):
            continue
        idx = d / "INDEX.md"
        fm = parse_front_matter(idx)
        rel = idx.relative_to(ROOT)

        # §10 tells you to group units into bounded contexts past 12 top-level
        # units, and says the parent "keeps only the INDEX". That parent has no
        # layer, no contract and no source — so following the protocol's own
        # scaling advice made this checker fail with no legal way to satisfy it.
        # `layer: group` marks a router over units rather than a unit.
        if fm.get("layer") == "group":
            groups.add(d)
            if fm.get("source"):
                errors.append(f"{rel}: a group index owns no code — move `source:` "
                              f"to the sub-unit that actually holds it")
            if not any(c.is_dir() and (c / "INDEX.md").exists() for c in d.iterdir()):
                errors.append(f"{rel}: layer: group but no sub-units beneath it")
            continue

        for k in REQUIRED_KEYS:
            if k not in fm:
                errors.append(f"{rel}: missing front-matter key '{k}'")
        uid = fm.get("id")
        if uid:
            if uid in units:
                errors.append(f"{rel}: duplicate unit id '{uid}'")
            units[uid] = fm

        n = body_lines(idx)
        if n > MAX_INDEX_LINES:
            errors.append(f"{rel}: INDEX body is {n} lines (max {MAX_INDEX_LINES}) — it is a "
                          f"router, not content. Front matter is not counted; if the "
                          f"changelog is what grew, cut it to {MAX_CHANGELOG_ROWS} rows "
                          f"(§10) — git keeps the rest")

        c = d / "contract.md"
        if c.exists():
            # The cap is per file, not per unit. A unit that is genuinely one
            # surface (a bot, a panel) cannot be split into two units, and the
            # old message pushed toward compressing healthy prose to buy back a
            # few lines. A topic file keeps the ceiling honest while leaving a
            # legal move (§10).
            for part in [c] + sorted(d.glob("contract.*.md")):
                n = len(part.read_text(encoding="utf-8").splitlines())
                if n > MAX_CONTRACT_LINES:
                    errors.append(
                        f"{part.relative_to(ROOT)}: {n} lines (max {MAX_CONTRACT_LINES}) — "
                        f"move a section into contract.<topic>.md and link it from "
                        f"contract.md, or split the unit if the halves have different "
                        f"consumers (§10)")
        elif fm.get("status") == "active":
            errors.append(f"{rel}: status active but no contract.md")

        # §2 requires front matter on every unit file, but only INDEX.md was
        # ever parsed — so a broken or absent header on contract.md passed all
        # five checkers. contract.md is the file §0 ranks as intent; an
        # unreadable header there is worse than one on the router.
        for sib in sorted(d.glob("*.md")):
            if sib.name == "INDEX.md":
                continue
            sfm = parse_front_matter(sib)
            srel = sib.relative_to(ROOT)
            if not sfm:
                errors.append(f"{srel}: no readable front matter (§2 requires it on every unit file)")
                continue
            if sfm.get("id") and sfm["id"] != uid:
                errors.append(f"{srel}: id '{sfm['id']}' does not match the unit id '{uid}'")

        # §10: the INDEX changelog is capped at 5 rows, because an unbounded
        # append cannot coexist with a 40-line router. Git holds the rest.
        rows = [l for l in idx.read_text(encoding="utf-8").splitlines()
                if l.strip().startswith("|") and re.search(r"\d{4}-\d{2}-\d{2}", l)]
        if len(rows) > MAX_CHANGELOG_ROWS:
            errors.append(f"{rel}: changelog has {len(rows)} rows (max {MAX_CHANGELOG_ROWS}) — "
                          f"drop the oldest; `git log --follow {d.relative_to(ROOT)}/` has them all")

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
    #
    # This used to be `uid not in mtext`, which is a substring test: a unit with
    # `id: ai` passed while completely absent, because "ai" occurs inside
    # "domains". Short ids are exactly the ones a real project uses (ai, ui, db,
    # i18n), so the check silently exempted them. Match the id cell of a table
    # row or a link target instead.
    master = (DOCS / "MASTER_INDEX.md")
    if master.exists():
        mtext = master.read_text(encoding="utf-8")
        listed = set()
        for line in mtext.splitlines():
            s = line.strip()
            if s.startswith("|"):
                cells = [c.strip().strip("_*`") for c in s.strip("|").split("|")]
                if cells:
                    m = re.match(r"^\[([^\]]*)\]", cells[0])
                    listed.add((m.group(1) if m else cells[0]).strip())
            for m in re.finditer(r"\((?:\./)?(?:domains|interfaces|platform)/([^/)]+)/", s):
                listed.add(m.group(1))
        for uid in units:
            if uid not in listed:
                errors.append(f"unit '{uid}' is not listed in MASTER_INDEX.md")

    check_claimed_paths()

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
