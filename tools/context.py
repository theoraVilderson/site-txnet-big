#!/usr/bin/env python3
"""Build a paste-ready session bundle for an agent with no filesystem access.

For Claude Code, Cursor, Codex, Aider and anything else that can read files and
run a shell, you do not need this: the agent reads `AGENTS.md` itself. This is
for a plain chat window or a raw OpenRouter/API call, where the model can see
only what you paste.

Paste the output **once** at the start of a session. Not every message.

usage:
    python3 tools/context.py                     start a session (protocol + state)
    python3 tools/context.py --item F-0201       + that feature's spec block
    python3 tools/context.py --find "profile button"   + where.py resolution
    python3 tools/context.py --lean              swap the full protocol for a digest
    python3 tools/context.py --unit billing      + that unit's INDEX + contract
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
UNIT_DIRS = ["domains", "interfaces", "platform"]

DIGEST = """\
# PROTOCOL DIGEST (the full text is docs/00-PROTOCOL.md)

AUTHORITY ORDER, highest first: running code and schema > invariants.md >
accepted ADRs > contract.md / rules.md. Code and intent disagree -> STOP and
report drift; never silently rewrite either. Never duplicate a fact that lives
in code; link to it.

READ IN TIERS, stop at the shallowest that answers the question:
  0  MASTER_INDEX.md            always, first
  0b where.py "<request>"       the request names a thing, not a unit
  1  the unit's INDEX.md        always
  1b spec.py <F-id>             the backlog row names a spec ref
  2  contract.md + invariants.md   changing or using the unit
  3  contract.md of each depends_on — the API section only
  4  rules.md, data-model.md    writing code inside that unit
  5  the source files           implementing
Never read all of docs/. Never open docs/features/App-Features.md. If a task
seems to need >8 doc files, say so — the change is too broad or a unit is split
wrong.

UNCERTAINTY: two responses only. BLOCKING (data model, money, auth, tenancy,
anything irreversible) -> ask, do not proceed. NON-BLOCKING -> proceed with a
default tagged `ASSUMED(YYYY-MM-DD): ...` plus a line in open-questions.md.

DONE means code exists and is reachable. Not documented, not planned.
Half-finished work stays `doing` with a note, never silently `done`.

CONTRACT CHANGES: additive and optional -> patch. Removing, renaming or changing
a meaning -> breaking: bump version, list consumers from depends_on, keep the
old shape @deprecated for one release, say the consumer list out loud first.
A unit never reaches into another unit's tables. Cross-unit access goes through
contract.md only.

NEVER: rename an id · renumber a catalog id · write a line number into a doc ·
delete a catalog row (move it to DROPPED.md with a reason) · add a field, table,
endpoint or dependency that was not requested · mark work done while an
invariant is violated or a blocking question is open.
"""

HEADER = """\
================================================================================
SESSION BUNDLE — everything you may assume about this project.

You have no filesystem and no shell. Do not ask me to find files for you; ask me
to run one of the commands below and paste its output.

  python3 tools/where.py "<a description>"   -> which unit and file that is
  python3 tools/spec.py <F-id>               -> that feature's spec block
  python3 tools/backlog.py                   -> progress and what is next

Never ask for docs/features/App-Features.md. It is thousands of lines. Ask for
the spec.py output for a specific id instead.

Give me COMPLETE files with their exact paths, never diffs or fragments — I am
saving them by hand. When the session is ending, output the full text of
docs/HANDOFF.md and any changed docs/BACKLOG.md rows.
================================================================================
"""


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").rstrip()
    except Exception:
        return ""


def run(args) -> str:
    try:
        r = subprocess.run([sys.executable] + args, cwd=ROOT,
                           capture_output=True, text=True, timeout=60)
        return (r.stdout or r.stderr).rstrip()
    except Exception as e:
        return f"(could not run {' '.join(args)}: {e})"


def block(title: str, body: str) -> str:
    if not body.strip():
        return ""
    return f"\n\n----- {title} " + "-" * max(0, 66 - len(title)) + f"\n\n{body}"


def handoff_is_active() -> bool:
    t = read(DOCS / "HANDOFF.md")
    for ln in t.splitlines()[1:]:
        if ln.strip() == "---":
            break
        s = ln.split("#")[0].strip()          # `status: empty  # empty | active`
        if s.startswith("status:"):
            return s.split(":", 1)[1].strip().lower() == "active"
    return False


def unit_path(uid: str):
    for d in UNIT_DIRS:
        p = DOCS / d / uid
        if p.is_dir():
            return p
    return None


def main() -> int:
    args = sys.argv[1:]

    def opt(name):
        return args[args.index(name) + 1] if name in args and len(args) > args.index(name) + 1 else None

    out = [HEADER]
    out.append(DIGEST if "--lean" in args else read(DOCS / "00-PROTOCOL.md"))
    out.append(block("AGENTS.md (project rules)", read(ROOT / "AGENTS.md")))
    out.append(block("docs/MASTER_INDEX.md", read(DOCS / "MASTER_INDEX.md")))
    out.append(block("docs/BACKLOG.md", read(DOCS / "BACKLOG.md")))

    if handoff_is_active():
        out.append(block("docs/HANDOFF.md — WORK IN PROGRESS, read this first",
                         read(DOCS / "HANDOFF.md")))
    else:
        out.append(block("handoff", "none active — this is a fresh item, "
                                    "follow MODE: NEXT"))

    out.append(block("progress (tools/backlog.py)", run(["tools/backlog.py"])))

    find = opt("--find")
    if find:
        out.append(block(f'where.py "{find}"', run(["tools/where.py", find])))

    item = opt("--item")
    if item:
        out.append(block(f"spec.py {item}", run(["tools/spec.py", item])))

    uid = opt("--unit")
    if uid:
        up = unit_path(uid)
        if not up:
            out.append(block(f"unit {uid}", f"(no docs/*/{uid}/ folder)"))
        else:
            for f in ("INDEX.md", "contract.md", "invariants.md"):
                out.append(block(f"docs/{up.relative_to(DOCS)}/{f}", read(up / f)))

    text = "\n".join(x for x in out if x)
    print(text)
    approx = len(text) // 4
    print(f"\n\n[{len(text)} chars, roughly {approx:,} tokens — "
          f"paste this once, at the start of the session]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
