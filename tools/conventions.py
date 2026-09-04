#!/usr/bin/env python3
"""Enforce the house style declared in docs/CONVENTIONS.md.

A convention written only in prose gets followed most of the time. A convention
that fails a check gets followed every time. This turns the second kind into
something you can run, in any language, with no lint toolchain.

Conventions declare their own checks as fenced blocks inside CONVENTIONS.md:

    ```check C-02
    forbid: \\btry\\s*\\{
    in: apps/**/*.ts, apps/**/*.tsx
    except: apps/api/src/platform/safe/**
    message: wrap it in safeExecute() instead of a raw try/catch
    ```

Keys:
    forbid   regex that must NOT appear (reported per line)
    require  regex that MUST appear at least once per matched file
    in       comma-separated globs. required.
    except   comma-separated globs to skip
    message  what to do instead. required — a violation with no remedy is noise.

usage:
    python3 tools/conventions.py            check everything
    python3 tools/conventions.py C-02       check one convention
    python3 tools/conventions.py --list     what is declared, and what is not checked
"""
import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONV = ROOT / "docs" / "CONVENTIONS.md"
SKIP = {"node_modules", ".git", "dist", "build", ".next", "__pycache__",
        "vendor", "target", ".venv", "coverage", "docs"}
MAX_REPORT = 12

_s = importlib.util.spec_from_file_location("drift", Path(__file__).parent / "drift.py")
_d = importlib.util.module_from_spec(_s)
_s.loader.exec_module(_d)
glob_re = _d.glob_re


def parse():
    """-> (checks, declared_ids). Checks are dicts; declared_ids is every C-nn
    row in the tables, so --list can show which ones nothing enforces."""
    if not CONV.exists():
        return [], []
    text = CONV.read_text(encoding="utf-8")
    declared = []
    for ln in text.splitlines():
        m = re.match(r"^\|\s*(C-\d{2,3})\s*\|", ln.strip())
        if m and "_" not in ln:
            declared.append(m.group(1))

    checks = []
    for m in re.finditer(r"^```check\s+(C-\d{2,3})\s*\n(.*?)^```", text,
                         re.S | re.M):
        cid, body = m.group(1), m.group(2)
        c = {"id": cid, "forbid": None, "require": None, "in": [],
             "except": [], "message": ""}
        for ln in body.splitlines():
            km = re.match(r"^\s*(forbid|require|in|except|message)\s*:\s*(.*)$", ln)
            if not km:
                continue
            k, v = km.group(1), km.group(2).strip()
            if k in ("in", "except"):
                c[k] = [x.strip() for x in v.split(",") if x.strip()]
            else:
                c[k] = v
        if not c["in"] or not c["message"]:
            print(f"  SKIP {cid}: a check needs both `in:` and `message:`",
                  file=sys.stderr)
            continue
        if not (c["forbid"] or c["require"]):
            print(f"  SKIP {cid}: needs `forbid:` or `require:`", file=sys.stderr)
            continue
        checks.append(c)
    return checks, declared


def files_for(c):
    inc = [glob_re(g) for g in c["in"]]
    exc = [glob_re(g) for g in c["except"]]
    out = []
    for p in ROOT.rglob("*"):
        if not p.is_file() or (SKIP & set(p.parts)):
            continue
        rel = str(p.relative_to(ROOT))
        if any(rx.match(rel) for rx in inc) and not any(rx.match(rel) for rx in exc):
            out.append((p, rel))
    return sorted(out, key=lambda x: x[1])


def run(c):
    try:
        rx = re.compile(c["forbid"] or c["require"])
    except re.error as e:
        return [f"(bad regex in {c['id']}: {e})"], 0
    hits, n = [], 0
    for p, rel in files_for(c):
        try:
            lines = p.read_text(encoding="utf-8", errors="ignore").splitlines()
        except Exception:
            continue
        n += 1
        if c["forbid"]:
            for i, ln in enumerate(lines, 1):
                if rx.search(ln):
                    hits.append(f"{rel}:{i}  {ln.strip()[:70]}")
        else:
            if not any(rx.search(ln) for ln in lines):
                hits.append(f"{rel}  (missing)")
    return hits, n


def main() -> int:
    args = sys.argv[1:]
    checks, declared = parse()

    if not CONV.exists():
        print("docs/CONVENTIONS.md does not exist — nothing to enforce.")
        return 0

    if "--list" in args:
        checked = {c["id"] for c in checks}
        declared = sorted(set(declared) | checked)
        print(f"{len(declared)} convention(s) declared, {len(checked)} mechanically checked\n")
        for cid in declared:
            mark = "check" if cid in checked else "review only"
            print(f"  {cid}   {mark}")
        unchecked = [c for c in declared if c not in checked]
        if unchecked:
            print(f"\n{len(unchecked)} convention(s) rest on the agent reading and "
                  f"obeying prose.\nThat works most of the time. If one of them "
                  f"keeps getting violated,\nit wants a `check` block, not a "
                  f"firmer sentence.")
        return 0

    only = [a for a in args if re.fullmatch(r"C-\d{2,3}", a)]
    if only:
        checks = [c for c in checks if c["id"] in only]
        if not checks:
            print(f"no check block for {', '.join(only)}")
            return 2

    total = 0
    for c in checks:
        hits, n = run(c)
        if not hits:
            print(f"  ok    {c['id']}   {n} file(s)")
            continue
        total += len(hits)
        kind = "forbidden pattern" if c["forbid"] else "required pattern missing"
        print(f"\n  FAIL  {c['id']}   {len(hits)} {kind} in {n} file(s)")
        print(f"        {c['message']}")
        for h in hits[:MAX_REPORT]:
            print(f"          {h}")
        if len(hits) > MAX_REPORT:
            print(f"          … {len(hits) - MAX_REPORT} more")

    unchecked = len(set(declared)) - len({c["id"] for c in checks}) if not only else 0
    print(f"\n{total} violation(s)"
          + (f"   ({unchecked} convention(s) not mechanically checked — "
             f"`--list`)" if unchecked > 0 else ""))
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
