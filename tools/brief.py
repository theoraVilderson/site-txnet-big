#!/usr/bin/env python3
"""Print the whole input set for one backlog row, in one command.

The read protocol (`00-PROTOCOL.md` §3) narrows to a unit and stops. Between
"the row names unit X" and "these four files govern this row" sits a discovery
step that every session pays again: open the unit's INDEX router, read the
`Files` table, guess which `contract.<topic>.md` applies, find the dependency
row's contract the same way, then look up the conventions. That is eight reads
to learn something the repo already knows.

This tool does that lookup. It reads no source, decides nothing, and writes
nothing — it names the files worth opening and the commands worth running, so a
session's first expensive read is the first *useful* one.

It is a funnel, not a summary. Every path it prints is still read by the agent;
what it removes is the search, and the re-reading of three cross-cutting files
(the protocol, `CODE-LAYOUT.md`, `CONVENTIONS.md`) whose relevant slice for one
row is a few dozen lines out of 1275.

usage:
    python3 tools/brief.py F-093-c       the row's full briefing
    python3 tools/brief.py --next        brief the first eligible row
    python3 tools/brief.py F-093-c -q    paths only, no prose (for a re-read)
"""
import os
import re
import sys
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
UNIT_LAYERS = ("domains", "interfaces", "platform")
PROTOCOL = DOCS / "00-PROTOCOL.md"
CONV = DOCS / "CONVENTIONS.md"

backlog = import_module("backlog")
docs_check = import_module("docs-check")
conventions = import_module("conventions")

ID_RE = re.compile(r"^[A-Z]+-\d+(?:-[a-z0-9]+)?$")


# ---------------------------------------------------------------- the row

def find_row(rows, rid):
    for r in rows:
        if r["id"] == rid:
            return r
    return None


def eligibility(row, by_id):
    """-> (verdict, lines). The same rule `backlog.py` applies, said per dep so
    a blocked row names its blocker instead of only failing."""
    lines, ok = [], True
    for d in row["deps"]:
        dep = by_id.get(d)
        st = dep["status"] if dep else "UNKNOWN ROW"
        mark = "ok" if st == "done" else "BLOCKS"
        if st != "done":
            ok = False
        lines.append(f"    {mark:<7} {d}  [{st}]")
    if row["status"] != "todo":
        ok = False
    if "needs-decision" in (row.get("note") or ""):
        ok = False
        lines.append("    BLOCKS  flagged needs-decision — ask the user first (§9)")
    items = list(by_id.values())
    if backlog.umbrella_children(row, items) is not None:
        ok = False
        still = backlog.open_children(row, items)
        lines.append(f"    BLOCKS  an umbrella — no work of its own; {len(still)} child row(s) open"
                     + (f": {', '.join(c['id'] for c in still[:6])}" if still else
                        " — close it with the children's proof"))
    return ok, lines


# ------------------------------------------------------- the protocol slice

def protocol_section(pattern):
    """One `## ` section of the fixed protocol, by heading regex.

    Read-only, and the point of it: MODE: NEXT is 25 lines of a 687-line file,
    and a session that reads the whole thing has paid for six modes it is not
    in. The file itself is never touched — it is `status: fixed`.
    """
    if not PROTOCOL.exists():
        return []
    out, taking = [], False
    for ln in PROTOCOL.read_text(encoding="utf-8").splitlines():
        if ln.startswith("## "):
            if taking:
                break
            taking = bool(re.search(pattern, ln))
        if taking:
            out.append(ln)
    return [ln for ln in out if ln.strip() not in {"---", ""}]


# ------------------------------------------------------------- unit lookup

def unit_dir(unit):
    for layer in UNIT_LAYERS:
        p = DOCS / layer / unit / "INDEX.md"
        if p.exists():
            return p.parent
    return None


def index_files_table(index_path):
    """-> [(filename, 'read it when')] from the unit INDEX's `## Files` table."""
    out = []
    for ln in index_path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*$", ln)
        if m:
            out.append((m.group(2), m.group(3)))
    return out


def docs_naming(ids):
    """Which unit doc files name any of these row ids, and on what line.

    This is the step the tool exists for. A `contract.<topic>.md` says which
    backlog row it was written for — `contract.shell.md` names F-093-a, and
    `billing/contract.history.md` names F-092-n — so the row's own id and its
    dependencies' ids are enough to find every contract that governs it. Doing
    it by hand means opening the router and guessing; doing it here is one walk
    over a few hundred small files.
    """
    hits = {}
    wanted = [i for i in ids if i]
    if not wanted:
        return hits
    rx = re.compile("|".join(re.escape(i) for i in wanted))
    for layer in UNIT_LAYERS:
        base = DOCS / layer
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.md")):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            for ln in text.splitlines():
                if not rx.search(ln):
                    continue
                rel = str(path.relative_to(ROOT))
                hits.setdefault(rel, []).append(ln.strip())
    return hits


# -------------------------------------------------------------- conventions

def conventions_in_play(unit_fm):
    """-> (enforced, review_only). The C-nn ids whose files overlap this unit's
    `source:`, told apart by whether anything actually fails on a violation."""
    checks, declared = conventions.parse()
    source = unit_fm.get("source") or []
    if isinstance(source, str):
        source = [source]
    unit_rx = [conventions.glob_re(g) for g in source]
    if not unit_rx:
        return [], declared
    unit_files = {rel for _, rel in conventions._all_files()
                  if any(rx.match(rel) for rx in unit_rx)}
    enforced = []
    for c in checks:
        covered = {rel for _, rel in conventions.files_for(c)}
        overlap = covered & unit_files
        if overlap:
            enforced.append((c["id"], len(overlap), c["message"]))
    ids = {cid for cid, _, _ in enforced}
    return sorted(enforced), [d for d in declared if d not in ids]


def convention_rules():
    """-> {C-nn: the one-line rule from the table}, for the review-only ones."""
    out = {}
    if not CONV.exists():
        return out
    for ln in CONV.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\|\s*(C-\d{2,3})\s*\|\s*(.*?)\s*\|\s*([a-z]+)\s*\|\s*$",
                     ln.strip())
        if m:
            out[m.group(1)] = (m.group(2), m.group(3))
    return out


# -------------------------------------------------------------- test tiers

TS_ROOTS = ("txnet-backend/",)
WEB_ROOTS = ("site-pwa/", "coinsite/")
GO_ROOTS = ("auth-handler/", "i18n-platform/")


def test_plan(unit_fm):
    source = unit_fm.get("source") or []
    if isinstance(source, str):
        source = [source]
    stacks = set()
    for g in source:
        if g.startswith(TS_ROOTS):
            stacks.add("nest")
        elif g.startswith(WEB_ROOTS):
            stacks.add("web")
        elif g.startswith(GO_ROOTS):
            stacks.add("go")
    return stacks


# ------------------------------------------------------------------- output

def hr(title):
    return f"\n{'─' * 4} {title} {'─' * max(4, 66 - len(title))}"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    flags = {a for a in sys.argv[1:] if a.startswith("-")}
    quiet = "-q" in flags or "--quiet" in flags

    rows = backlog.rows()
    by_id = {r["id"]: r for r in rows}

    if "--next" in flags:
        eligible = [r for r in rows if backlog.is_eligible(r, by_id, rows)]
        if not eligible:
            print("no eligible row — run tools/backlog.py to see why", file=sys.stderr)
            return 1
        rid = eligible[0]["id"]
    elif args:
        rid = args[0]
    else:
        print(__doc__.strip().split("usage:")[1].strip(), file=sys.stderr)
        return 2

    row = find_row(rows, rid)
    if row is None:
        print(f"{rid}: not a backlog row. Check docs/BACKLOG.md", file=sys.stderr)
        return 2

    unit = row["unit"]
    udir = unit_dir(unit)
    paths = []

    # --- the row ------------------------------------------------------------
    print(hr(f"ROW {rid}"))
    print(f"  feature   {row['feature']}")
    print(f"  unit      {unit}" + (f"  ->  {udir.relative_to(ROOT)}/" if udir else
                                   "   (NO UNIT DOC — this is a finding, not a gap to fill)"))
    print(f"  status    {row['status']}")
    print(f"  spec ref  {row['spec'] or '—'}")
    if row["note"]:
        print(f"  note      {row['note']}")

    ok, dep_lines = eligibility(row, by_id)
    print(f"\n  eligible  {'YES' if ok else 'NO'}")
    for ln in dep_lines:
        print(ln)
    if not row["deps"]:
        print("    (no dependencies)")
    if not ok and not quiet:
        print("\n  §6b.2: a row that is not `todo` with every dependency `done` is")
        print("  built out of order. Say so and stop rather than building it.")

    # --- the spec -----------------------------------------------------------
    print(hr("SPEC"))
    if row["spec"] and row["spec"] not in {"—", "-"}:
        print(f"  catalog id {row['spec']} — resolve it, never open the catalog:")
        print(f"      python3 tools/spec.py {row['spec']}")
    else:
        print("  no catalog id. The spec is this row's `note`.")

    # --- the unit -----------------------------------------------------------
    if udir:
        fm = docs_check.parse_front_matter(udir / "INDEX.md")
        print(hr(f"UNIT {unit}"))
        print(f"  status     {fm.get('status', '?')}   version {fm.get('version', '?')}")
        src = fm.get("source") or []
        print(f"  source     {', '.join(src) if isinstance(src, list) else src}")
        dep_units = fm.get("depends_on") or []
        print(f"  depends_on {', '.join(dep_units) if dep_units else '—'}")

        table = index_files_table(udir / "INDEX.md")
        if table:
            print("\n  the unit's own docs (INDEX router):")
            for fname, when in table:
                rel = str((udir / fname).relative_to(ROOT))
                print(f"      {rel}")
                print(f"          {when}")

        # --- which of them actually govern this row -------------------------
        ids = [rid] + row["deps"]
        hits = docs_naming(ids)
        if hits:
            print(hr("GOVERNING CONTRACTS (doc files that name this row or a dependency)"))
            for rel, lines in sorted(hits.items()):
                if rel.endswith("INDEX.md") and len(lines) > 3:
                    continue
                paths.append(rel)
                print(f"      {rel}")
                for ln in lines[:2]:
                    print(f"          {ln[:150]}")
            if not quiet:
                print("\n  These are tier 2/3 for this row: the rules it has to hold, already")
                print("  written down. Read these before the unit's other contract files.")

        # --- tier 3, bounded ------------------------------------------------
        if dep_units and not quiet:
            print(hr("TIER 3 (dependency units — read only the rows you call, §3)"))
            for du in dep_units:
                dd = unit_dir(du)
                if not dd:
                    print(f"      {du}: no unit doc")
                    continue
                contracts = sorted(p.name for p in dd.glob("contract*.md"))
                print(f"      {du}: {', '.join(contracts)}")
                print(f"          in {dd.relative_to(ROOT)}/")

        # --- conventions ----------------------------------------------------
        enforced, review = conventions_in_play(fm)
        rules = convention_rules()
        print(hr("CONVENTIONS (tier 4 — before the first line of code)"))
        if enforced:
            print("  a check fails on a violation inside this unit:")
            for cid, n, msg in enforced:
                print(f"      {cid}  ({n} file(s))  {msg[:90]}")
        if review:
            print("\n  nothing here fails on a violation — these are yours to hold:")
        for cid in review:
            rule, how = rules.get(cid, ("", "review"))
            # `how` is the convention's own column: `check` means it is enforced
            # somewhere, just not over this unit's files. Saying "review" for
            # those would be a lie in the other direction.
            where = "review only" if how == "review" else f"{how}s elsewhere"
            print(f"      {cid}  [{where}]  {rule[:100]}")
        if not quiet:
            print("\n  Never route around one to make something work: name the id and ask.")

        # --- tests ----------------------------------------------------------
        stacks = test_plan(fm)
        print(hr("TESTS (the spec comes first — CODE-LAYOUT.md 'Order of work')"))
        print("  Budget: ONE new *.spec.ts for this row, covering the invariant it")
        print("  turns on. Write it, watch it fail for the reason you expect, then")
        print("  implement. *.int.spec.ts / *.e2e.spec.ts only if a contract.md row changes.")
        if "nest" in stacks:
            print("\n  iterate (one project, ~10s):")
            print("      cd txnet-backend && npx vitest run -c <project>/vitest.config.mts <path>")
            print("      npx tsc -p <project>/tsconfig.app.json --noEmit        # ~20s")
        if "web" in stacks:
            print("\n  iterate (site-pwa):")
            print("      cd site-pwa && npx vitest run <path>")
        if "go" in stacks:
            print("\n  iterate (go):")
            print("      PATH=$PATH:/usr/local/go/bin go test ./...")
        print("\n  Never start an e2e run the user did not ask for.")

    # --- checks -------------------------------------------------------------
    print(hr("BEFORE DECLARING DONE"))
    print("  The six doc checks are ~6s in total. Run them whole:")
    print("      for t in docs-check backlog features-scan where conventions contracts; do \\")
    print("        case $t in features-scan|where) a=--check;; *) a=;; esac; \\")
    print("        python3 tools/$t.py $a || echo \"FAILED $t\"; done")
    # Printed whatever the unit is: a row's *unit* can be `panel-web` while the
    # change still reaches `txnet-backend` — a panel feature that needs one
    # backend route is the normal case, not the exception — and `source:` cannot
    # know that in advance. AGENTS.md ties these two to the language, not to the
    # unit, so the condition is stated and left to the reader.
    print("\n  If the change touched TypeScript under txnet-backend/, both of these")
    print("  run too, over the projects Nx says the change reaches (user, 2026-09-18;")
    print("  60s measured for a one-service change, vs ~180s for the workspace):")
    print("      cd txnet-backend && { npm run test:affected > /tmp/test.log 2>&1 & ")
    print("                            npm run typecheck:affected > /tmp/tc.log 2>&1 & wait; }")
    print("  Note the braces: `cd X && (A) & (B) &` binds the cd to the FIRST")
    print("  subshell only, and the second one runs in the wrong directory.")
    print("\n  Do NOT add a third suite to that pair. site-pwa's vitest alongside the")
    print("  workspace's seven projects oversubscribes the machine and fails ~130")
    print("  files that pass on their own — the contention CODE-LAYOUT.md warns")
    print("  about, arriving as a wall of red that looks like a real regression.")
    print("  Never replace them with a project you picked: the set is Nx's import graph.")
    print("  The whole pair (npm test, npm run typecheck) only when the graph cannot see")
    print("  the change — a computed import(), a file outside every project, nx.json.")
    print("\n  §11: update every doc of the behaviour this row changes, and no other unit's prose. A changelog row only for")
    print("  a version bump, a status flip or a contract break. A BACKLOG note is 3 lines.")
    # The row is written by column name. Splicing the line by hand is how a
    # proof path lands in `spec ref` (2026-09-20) — see AGENTS.md "Finishing one".
    print(f"\n  Write the row itself — by column name, never by splicing the line:")
    print(f"      python3 tools/backlog.py --set {rid} status=done proof='<path>' note+='<3 lines, cites the contract>'")

    # --- the mode -----------------------------------------------------------
    if not quiet:
        sec = protocol_section(r"MODE:\s*NEXT")
        if sec:
            print(hr("PROTOCOL §6b — MODE: NEXT (the slice in play, not all 687 lines)"))
            for ln in sec:
                print(f"  {ln}")

    if quiet:
        print(hr("PATHS"))
        for p in dict.fromkeys(paths):
            print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
