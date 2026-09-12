#!/usr/bin/env python3
"""What a session pays to read this repo's docs, and whether it is getting worse.

`00-PROTOCOL.md` §3 caps what one *task* may read. Nothing caps the growth of the
files every task must read — and those are the ones that grow with the project
rather than with the work. On 2026-09-12 the set below was 451 KB (~113k tokens),
60% of it `BACKLOG.md`'s `note` column: history that `git log --grep 'spec: <id>'`
already holds, re-read at the start of every session.

This tool makes that number visible instead of felt. It measures, it does not
fix: a session that feels slow should run this first, and a proposal to make the
repo faster should quote it.

usage:
    python3 tools/cost.py              today's tax + the trend from git
    python3 tools/cost.py --trend 12   more sample points
    python3 tools/cost.py --quiet      the one total, for a script
"""
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module

ROOT = Path(__file__).resolve().parent.parent
backlog = import_module("backlog")

# What a MODE: NEXT session is told to read, or ends up reading. `BACKLOG.md` and
# `MASTER_INDEX.md` are §6b.1's explicit pair; the rest are the cross-cutting
# files tiers 0/4/4b send you to, and `SURFACES.md` is §3b's entry point.
FIXED_SET = [
    ("docs/BACKLOG.md", "§6b.1 — read whole at the start of every NEXT session"),
    ("docs/SURFACES.md", "§3b — the entry point for a request with no path in it"),
    ("docs/00-PROTOCOL.md", "the authority (fixed file — only its mode is in play)"),
    ("docs/CODE-LAYOUT.md", "tier 4b — symptom -> role, and the test policy"),
    ("docs/CONVENTIONS.md", "tier 4 — before writing code inside any unit"),
    ("docs/MASTER_INDEX.md", "tier 0 — always"),
]

# chars/4, the usual rough ratio. Labelled an estimate everywhere it is printed,
# because a precise-looking token count nobody can reproduce is worse than none.
CHARS_PER_TOKEN = 4


def tokens(n_chars):
    return n_chars // CHARS_PER_TOKEN


def human(n):
    return f"{n / 1024:.0f} KB" if n >= 1024 else f"{n} B"


def size_now(rel):
    p = ROOT / rel
    return p.stat().st_size if p.exists() else 0


def size_at(sha, rel):
    """The file's size in one commit, or 0 when it did not exist there yet."""
    try:
        out = subprocess.run(
            ["git", "cat-file", "-s", f"{sha}:{rel}"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        return int(out.stdout.strip())
    except (subprocess.CalledProcessError, ValueError):
        return 0


def sample_commits(n):
    """-> [(sha, date)] spread over the history of the fixed set, oldest first.

    Spread rather than the last n commits: the last n are usually one day's work,
    and a trend over one day says nothing about whether the repo is getting
    heavier.
    """
    out = subprocess.run(
        ["git", "log", "--format=%H %ad", "--date=short", "--"]
        + [rel for rel, _ in FIXED_SET],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    if not out:
        return []
    rows = [ln.split(" ", 1) for ln in out]
    rows.reverse()
    if len(rows) <= n:
        return rows
    step = (len(rows) - 1) / (n - 1)
    picked = [rows[round(i * step)] for i in range(n)]
    # `round` can land twice on one commit in a short history.
    seen, unique = set(), []
    for sha, date in picked:
        if sha not in seen:
            seen.add(sha)
            unique.append((sha, date))
    return unique


def backlog_detail():
    """The note column on its own — the part of the tax that is pure history."""
    rows = backlog.rows()
    notes = [(len(r["note"] or ""), r["id"]) for r in rows]
    total = sum(n for n, _ in notes)
    # ~3 rendered lines at 80 columns is the §11 cap; 240 chars is that in one
    # number. It is a threshold for a report, not a checker's verdict.
    over = [(n, i) for n, i in notes if n > 240]
    return rows, total, sorted(over, reverse=True)


def main():
    argv = sys.argv[1:]
    quiet = "--quiet" in argv or "-q" in argv
    n = 8
    if "--trend" in argv:
        try:
            n = max(2, int(argv[argv.index("--trend") + 1]))
        except (IndexError, ValueError):
            print("--trend takes a number of sample points", file=sys.stderr)
            return 2

    total = sum(size_now(rel) for rel, _ in FIXED_SET)
    if quiet:
        print(f"{total} {tokens(total)}")
        return 0

    print("THE FIXED READ TAX — what a session pays before the first useful read")
    print(f"  {'file':<26} {'size':>8} {'~tokens':>9}   why it is in this list")
    for rel, why in sorted(FIXED_SET, key=lambda x: -size_now(x[0])):
        n_chars = size_now(rel)
        print(f"  {rel.replace('docs/', ''):<26} {human(n_chars):>8} "
              f"{tokens(n_chars):>9,}   {why}")
    print(f"  {'TOTAL':<26} {human(total):>8} {tokens(total):>9,}")

    rows, note_total, over = backlog_detail()
    share = (100 * note_total // total) if total else 0
    print("\nBACKLOG.md's note column — the part that is history, not plan")
    print(f"  {len(rows)} rows, {human(note_total)} of notes "
          f"(~{tokens(note_total):,} tokens, {share}% of the whole tax)")
    print(f"  over §11's 3-line cap: {len(over)} of {len(rows)} rows", end="")
    if over:
        print("   worst: " + ", ".join(f"{i} ({n})" for n, i in over[:5]))
    else:
        print()
    print("  §10 already answers this for a unit INDEX: keep the last few, let")
    print("  `git log --grep 'spec: <id>'` hold the rest. It was never applied here.")

    print(f"\nTHE CHEAP PATH — what the same session pays using the tools")
    print("  python3 tools/brief.py --next        ~600 tokens, 0.7s")
    print(f"  reading BACKLOG.md whole            ~{tokens(size_now('docs/BACKLOG.md')):,} tokens")
    print("  python3 tools/where.py \"<words>\"     ~400 tokens, instead of SURFACES.md")

    samples = sample_commits(n)
    if len(samples) >= 2:
        print(f"\nTREND — is the tax growing? ({len(samples)} points across the history)")
        first = None
        for sha, date in samples:
            at = sum(size_at(sha, rel) for rel, _ in FIXED_SET)
            first = at if first is None else first
            bar = "#" * max(1, round(40 * at / max(total, 1)))
            print(f"  {date}  {human(at):>8}  {bar}")
        print(f"  now         {human(total):>8}  {'#' * 40}")
        # Deliberately not a percentage against the first point: that is the
        # bootstrap commit, where the docs barely existed, and a growth figure
        # off a near-zero base says nothing. The recent slope is the signal.
        mid = samples[len(samples) // 2]
        mid_total = sum(size_at(mid[0], rel) for rel, _ in FIXED_SET)
        days = _days_between(mid[1], samples[-1][1]) or 1
        rate = (total - mid_total) / days
        print(f"\n  Since {mid[1]}: {human(mid_total)} -> {human(total)}"
              f"  (~{human(int(rate))}/day over {days} day(s))")
        print("  The work did not grow at that rate. This is what every future")
        print("  session pays for every past session.")
    return 0


def _days_between(a, b):
    from datetime import date
    try:
        ya, ma, da = (int(x) for x in a.split("-"))
        yb, mb, db = (int(x) for x in b.split("-"))
        return (date(yb, mb, db) - date(ya, ma, da)).days
    except ValueError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
