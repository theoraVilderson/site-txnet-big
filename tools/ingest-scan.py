#!/usr/bin/env python3
"""Turn a large legacy markdown corpus into a cheap section-level manifest.

The agent reads the manifest (a few KB) instead of the corpus (hundreds of KB),
then reads only the exact line ranges it needs, one unit at a time.

usage:
    python3 tools/ingest-scan.py <legacy-docs-dir> [-o docs/_legacy/MANIFEST.md]
"""
import argparse
import re
from pathlib import Path

# things worth anchoring unit boundaries on
TABLE_RE = re.compile(
    r"\b(?:CREATE\s+TABLE|model|table|جدول)\s+[`\"']?([A-Za-z_][A-Za-z0-9_]{2,})",
    re.IGNORECASE,
)
ID_RE = re.compile(r"\b([A-Z]{2,5}-\d{2,4})\b")  # DEC-01, INV-12, P-03, OQ-07 ...
ENDPOINT_RE = re.compile(r"\b(?:GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9/_:{}-]+)")


def sections(path: Path):
    """Yield (heading_path, level, start_line, end_line, body) for each heading."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    heads = []
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            heads.append((i, len(m.group(1)), m.group(2).strip()))
    if not heads:
        yield ("(no headings)", 0, 1, len(lines), "\n".join(lines))
        return
    stack = []
    for n, (i, lvl, title) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        stack = stack[: lvl - 1]
        while len(stack) < lvl - 1:
            stack.append("…")
        stack.append(title)
        yield (" › ".join(stack), lvl, i + 1, end, "\n".join(lines[i:end]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("-o", "--out", default="docs/_legacy/MANIFEST.md")
    ap.add_argument("--max-level", type=int, default=3,
                    help="only list headings at or above this depth")
    args = ap.parse_args()

    src = Path(args.src)
    files = sorted(p for p in src.rglob("*.md") if p.is_file())
    rows, total_lines, total_bytes = [], 0, 0
    all_tables, all_ids = set(), set()

    for f in files:
        total_bytes += f.stat().st_size
        for hpath, lvl, start, end, body in sections(f):
            total_lines += end - start
            if lvl > args.max_level:
                continue
            tables = sorted(set(TABLE_RE.findall(body)))
            ids = sorted(set(ID_RE.findall(body)))
            eps = sorted(set(ENDPOINT_RE.findall(body)))
            all_tables.update(tables)
            all_ids.update(ids)
            rows.append({
                "file": str(f.relative_to(src)),
                "range": f"{start}-{end}",
                "lines": end - start,
                "heading": hpath,
                "tables": ",".join(tables[:6]),
                "ids": ",".join(ids[:8]),
                "endpoints": ",".join(eps[:4]),
            })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        fh.write("# Legacy corpus manifest\n\n")
        fh.write(f"- files: {len(files)}\n- sections: {len(rows)}\n")
        fh.write(f"- total lines: {total_lines}\n- total bytes: {total_bytes}\n\n")
        fh.write("Read line ranges from the original files. Never read a whole "
                 "file unless it is under 200 lines.\n\n")
        fh.write("## Distinct identifiers found (preserve these EXACTLY)\n\n")
        fh.write(", ".join(sorted(all_ids)) + "\n\n")
        fh.write("## Candidate table names\n\n")
        fh.write(", ".join(sorted(all_tables)) + "\n\n")
        fh.write("## Sections\n\n")
        fh.write("| file | lines | heading | tables | ids | endpoints | → unit | done |\n")
        fh.write("|---|---|---|---|---|---|---|---|\n")
        for r in rows:
            fh.write(f"| {r['file']}:{r['range']} | {r['lines']} | {r['heading']} | "
                     f"{r['tables']} | {r['ids']} | {r['endpoints']} |  | ☐ |\n")

    print(f"wrote {out}  ({out.stat().st_size} bytes)")
    print(f"corpus: {len(files)} files / {total_bytes} bytes / {len(rows)} sections")
    print(f"identifiers: {len(all_ids)}   candidate tables: {len(all_tables)}")


if __name__ == "__main__":
    main()
