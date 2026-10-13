#!/usr/bin/env python3
"""Hold the shape of the code: size, state, dead files, dead dependencies.

`conventions.py` checks one line at a time. These four rules need a whole file
or the whole import graph, so they live here (C-20, C-21 in CONVENTIONS.md):

    size   a source file is at most MAX_LINES lines
    state  a React component file declares at most MAX_STATE `useState`s
    dead   every source file is imported by something that is not a test
    deps   every runtime dependency in a package.json is imported somewhere
    exports every exported name is used by another non-test file
    dupes  no block of DUPE_WINDOW meaningful lines is pasted into another file
    smells counted patterns that hide bugs or bypass the one way (C-24 … C-31)

Code written before these rules is listed in tools/codeshape.baseline.json.
The baseline is a ratchet: a listed file may shrink but not grow, an entry
that is fixed must leave the list, and nothing new may join it. `--tighten`
rewrites the baseline from the tree, and refuses if that would raise any
number or add any entry.

usage:
    python3 tools/codeshape.py              check (exit 1 on a violation)
    python3 tools/codeshape.py --tighten    lock in what got better (a new rule: adopt today's findings)
    python3 tools/codeshape.py --list dead  print one rule's current findings
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = Path(__file__).with_name("codeshape.baseline.json")

MAX_LINES = 400
MAX_STATE = 10
DUPE_WINDOW = 8

# App roots: the source tree, the tsconfig whose `paths` resolve its aliases,
# and the package.json whose `dependencies` it owns.
APPS = [
    {"src": "site-pwa/src", "tsconfig": "site-pwa/tsconfig.json", "pkg": "site-pwa"},
    {"src": "coinsite/src", "tsconfig": "coinsite/tsconfig.json", "pkg": "coinsite"},
    {"src": "txnet-backend", "tsconfig": "txnet-backend/tsconfig.base.json", "pkg": "txnet-backend"},
]
GO_ROOTS = ["auth-handler", "i18n-platform", "network-service", "sub-service"]

SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", ".nx", "coverage",
             "generated", "vendor", "tmp", ".agents", ".claude", ".cursor", ".devin"}
TEST_RE = re.compile(r"(\.(spec|test|e2e-spec)\.tsx?$|_test\.go$|/test-support/|-e2e/|/__tests__/)")
SOURCE_EXT = (".ts", ".tsx")

# Files a framework loads by name, never by import.
NEXT_ENTRY = re.compile(
    r"/app/.*/?(page|layout|route|loading|error|not-found|template|default|global-error|"
    r"opengraph-image|twitter-image|icon|apple-icon|manifest|sitemap|robots)\.tsx?$"
    r"|/src/(proxy|middleware|instrumentation)\.ts$")
BACKEND_ENTRY = re.compile(r"(/src/main\.ts$|/src/index\.ts$|/prisma/|/scripts/|\.config\.m?ts$|/seed[^/]*\.ts$)")

# Dependencies nothing imports by name that are still needed, each with why.
ALLOW_DEPS = {
    "react-dom": "Next renders through it; no app file imports it by name",
    "@grpc/grpc-js": "peer dependency of @txnet/locale-client",
    "@grpc/proto-loader": "peer dependency of @txnet/locale-client",
    "@nestjs/cli": "the `nest build` / `nest start` scripts",
    "tslib": "txnet-backend compiles with importHelpers",
}

# A file only specs import may say so in its first lines, with the reason:
#     // codeshape: spec-only — <why it is not dead>
# and so may one export, in the three lines above its declaration.
SPEC_ONLY = re.compile(r"codeshape:\s*spec-only\s*—\s*\S")

IMPORT_RE = re.compile(
    r"""(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]"""
    r"""|import\s*\(\s*['"]([^'"]+)['"]\s*\)"""
    r"""|import\s+['"]([^'"]+)['"]"""
    r"""|require\(\s*['"]([^'"]+)['"]\s*\)"""
    r"""|vi\.mock\(\s*['"]([^'"]+)['"]""")


def walk(base, exts):
    for dirpath, dirs, files in os.walk(ROOT / base):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith(exts) and not f.endswith((".d.ts", ".pb.go")):
                yield Path(dirpath) / f


def rel(p):
    return p.relative_to(ROOT).as_posix()


def read(p):
    try:
        return p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return ""


def load_paths(tsconfig):
    """tsconfig `paths` as [(prefix, [target dirs])]; JSONC comments stripped."""
    p = ROOT / tsconfig
    text = re.sub(r"^\s*//.*$|(?<=[,{\[\"])\s*//[^\n\"]*$", "", read(p), flags=re.M)
    text = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        paths = json.loads(text).get("compilerOptions", {}).get("paths", {})
    except json.JSONDecodeError:
        return []
    out = []
    for key, targets in paths.items():
        out.append((key.rstrip("*"), [(p.parent / t.rstrip("*")).resolve() for t in targets],
                    key.endswith("*")))
    return out


def resolve(spec, from_file, aliases):
    """-> the source file an import specifier names, or None (a package)."""
    bases = []
    if spec.startswith("."):
        bases.append((from_file.parent / spec).resolve())
    else:
        for prefix, targets, wild in aliases:
            if (wild and spec.startswith(prefix)) or spec == prefix:
                rest = spec[len(prefix):] if wild else ""
                bases += [t / rest if wild and rest else t for t in targets]
    for b in bases:
        if b.is_file():
            return b
        for ext in SOURCE_EXT:
            for cand in (Path(str(b) + ext), b / f"index{ext}"):
                if cand.is_file():
                    return cand
    return None


def find_size():
    out = {}
    for base in [a["src"] for a in APPS] + GO_ROOTS:
        for p in walk(base, SOURCE_EXT + (".go",)):
            r = rel(p)
            if TEST_RE.search(r):
                continue
            n = read(p).count("\n")
            if n > MAX_LINES:
                out[r] = n
    return out


def find_state():
    out = {}
    for a in APPS:
        for p in walk(a["src"], (".tsx",)):
            r = rel(p)
            if TEST_RE.search(r):
                continue
            n = len(re.findall(r"\buseState\b\s*[<(]", read(p)))
            if n > MAX_STATE:
                out[r] = n
    return out


def find_dead():
    out = {}
    for a in APPS:
        aliases = load_paths(a["tsconfig"])
        files = [p for p in walk(a["src"], SOURCE_EXT)]
        used = set()
        for p in files:
            if TEST_RE.search(rel(p)):
                continue
            for m in IMPORT_RE.finditer(read(p)):
                spec = next(g for g in m.groups() if g)
                hit = resolve(spec, p, aliases)
                if hit and hit != p:
                    used.add(hit)
        for p in files:
            r = rel(p)
            if TEST_RE.search(r) or NEXT_ENTRY.search("/" + r) or BACKEND_ENTRY.search("/" + r):
                continue
            if p.resolve() not in used and not SPEC_ONLY.search("\n".join(read(p).splitlines()[:15])):
                out[r] = 1
    return out


def find_deps():
    out = {}
    for a in APPS:
        pkg = ROOT / a["pkg"] / "package.json"
        deps = json.loads(read(pkg) or "{}").get("dependencies", {})
        text = []
        for p in walk(a["pkg"], SOURCE_EXT + (".js", ".mjs", ".cjs", ".mts", ".css")):
            text.append(read(p))
        for cfg in (ROOT / a["pkg"]).glob("*.json"):
            if cfg.name not in ("package.json", "package-lock.json"):
                text.append(read(cfg))
        blob = "\n".join(text)
        for d in deps:
            if d.startswith("@types/") or d in ALLOW_DEPS:
                continue
            if not re.search(r"""['"]""" + re.escape(d) + r"""(/[^'"]*)?['"]""", blob):
                out[f"{a['pkg']}/package.json:{d}"] = 1
    return out


# Trees whose C-24 smells ESLint holds (txnet-backend/eslint.config.mjs).
LINTED = "txnet-backend/"

COMMENT_LINE = re.compile(r"^\s*(//|\*|/\*|\{/\*)")

# name: (regex, path filter, convention, what to do instead). Counted per file
# on non-comment lines; a file's count may only shrink.
SMELLS = {
    # `any` and `!` in txnet-backend are held by ESLint (eslint-suppressions.json,
    # CS-1-j); counting them here too would be two baselines for one rule.
    "any": (r"\bas any\b|:\s*any\b\s*[,;)=\]>|]|<any>|\bany\[\]", lambda r: r.endswith(SOURCE_EXT)
            and not r.startswith(LINTED), "C-24", "type it, or take `unknown` and narrow it"),
    "double-cast": (r"\bas unknown as\b", lambda r: r.endswith(SOURCE_EXT),
                    "C-24", "a double cast lies to the compiler; parse or narrow the value"),
    "non-null": (r"[\w\])]!\.[A-Za-z_]", lambda r: r.endswith(SOURCE_EXT) and not r.startswith(LINTED),
                 "C-24", "handle the null case instead of asserting it away"),
    "lint-off": (r"eslint-disable(?!.*\s--\s)", lambda r: r.endswith(SOURCE_EXT),
                 "C-30", "fix the code; a disable that must stay says why after ` -- `"),
    "index-key": (r"key=\{(i|idx|index|j|n)\}", lambda r: r.endswith(".tsx"),
                  "C-30", "key a row by its id; an index key moves state between rows"),
    "raw-env": (r"process\.env\b", lambda r: r.endswith(SOURCE_EXT) and not re.search(
        r"(/env(\.validation)?\.ts$|/config/|\.config\.m?ts$)", r),
                "C-26", "read config from the app's validated env module"),
    "raw-storage": (r"\b(localStorage|sessionStorage)\.", lambda r: r.startswith("site-pwa/") and r.endswith(SOURCE_EXT),
                    "C-27", "go through the panel's storage helper, which survives a blocked storage"),
    "raw-fetch": (r"(?<![.\w])fetch\(", lambda r: r.startswith("site-pwa/") and r.endswith(SOURCE_EXT)
                  and not r.endswith("lib/api-request.ts"),
                  "C-27", "call the API through lib/api-request.ts"),
    "raw-service-call": (r"\[RequestHeaders\.serviceToken\]\s*:", lambda r: r.startswith("txnet-backend/")
                         and r.endswith(SOURCE_EXT) and not r.endswith("lib/http/service-call.ts"),
                         "C-27", "send serviceCallHeaders() (shared-core), which also forwards the request id (H13)"),
    "physical-side": (r"\b(ml|mr|pl|pr|left|right)-(\d|\[|auto|px)|\btext-(left|right)\b|\brounded-(l|r)-",
                      lambda r: r.startswith("site-pwa/") and r.endswith(SOURCE_EXT),
                      "C-31", "use logical sides (ms/me/ps/pe/start/end) so RTL and LTR both work"),
    "hex-color": (r"['\"`]#[0-9a-fA-F]{3,8}['\"`]", lambda r: r.startswith("site-pwa/") and r.endswith(SOURCE_EXT),
                  "C-31", "use a theme token"),
}

NEXT_EXPORTS = {"default", "metadata", "generateMetadata", "generateStaticParams", "generateViewport",
                "viewport", "dynamic", "dynamicParams", "revalidate", "runtime", "preferredRegion",
                "fetchCache", "maxDuration", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
                "config", "middleware", "proxy", "register", "onRequestError"}
EXPORT_RE = re.compile(
    r"^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?"
    r"(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)", re.M)
TOKEN_RE = re.compile(r"[A-Za-z_$][\w$]*")


def app_sources():
    """(path, rel) of every non-test, non-generated source file, all apps."""
    for a in APPS:
        for p in walk(a["src"], SOURCE_EXT):
            r = rel(p)
            if not TEST_RE.search(r):
                yield p, r


def find_smells():
    out = {}
    files = list(app_sources()) + [(p, rel(p)) for g in GO_ROOTS for p in walk(g, (".go",))
                                   if not TEST_RE.search(rel(p))]
    compiled = {k: (re.compile(v[0]), v[1]) for k, v in SMELLS.items()}
    for p, r in files:
        every = read(p).splitlines()
        code = [ln for ln in every if not COMMENT_LINE.match(ln)]
        for name, (rx, scope) in compiled.items():
            if scope(r):
                # A lint switch lives in a comment, so that one smell reads them.
                n = sum(len(rx.findall(ln)) for ln in (every if name == "lint-off" else code))
                if n:
                    out[f"{r} [{name}]"] = n
    return out


def find_exports():
    out = {}
    files = list(app_sources())
    text = {r: read(p) for p, r in files}
    seen = {}
    for r, t in text.items():
        for tok in set(TOKEN_RE.findall(t)):
            seen[tok] = seen.get(tok, 0) + 1
    for r, t in text.items():
        if NEXT_ENTRY.search("/" + r) or BACKEND_ENTRY.search("/" + r) or SPEC_ONLY.search(t[:2000]):
            continue
        for m in EXPORT_RE.finditer(t):
            name = m.group(1)
            # One export a spec needs (a cache reset, the TS side of a wire
            # contract) says so in the three lines above it, with the reason.
            if name in NEXT_EXPORTS or SPEC_ONLY.search("\n".join(t[:m.start()].splitlines()[-3:])):
                continue
            # Used nowhere else, and only declared here: nothing reaches it.
            # (Exported for a spec but used in its own file is not dead.)
            if seen.get(name, 0) <= 1 and len(re.findall(r"(?<![\w$])" + re.escape(name) + r"(?![\w$])", t)) <= 1:
                out[f"{r}:{name}"] = 1
    return out


def _norm(ln):
    s = ln.strip()
    if not s or COMMENT_LINE.match(s) or s.startswith(("import ", "export {", "} from", "package ")):
        return None
    s = re.sub(r"\s+", " ", s)
    if len(re.sub(r"[\s{}()\[\];,]", "", s)) < 4:
        return None
    return s


# Two files kept identical on purpose, each with the spec that holds them so.
# A block they share is a mirror, not a paste; one either shares with a third
# file still counts.
MIRRORS = {
    frozenset({"site-pwa/src/lib/lottery-draw.ts", "txnet-backend/shared-core/src/lib/engagement/lottery-draw.ts"}):
        "the verify page reruns the draw billing ran (ADR-0111 point 5); lotteries.test.ts holds them byte for byte",
}

# A whole import block — a TS `import {…} from` over many lines, a Go
# `import (…)` — is a list of names, not code that could be pasted: _norm drops
# an import's first line, and this drops the rest of it.
IMPORT_BLOCK = re.compile(r"""^(?:import|export)\b[^;'"]*?\bfrom\s*['"][^'"]+['"];?|^import\s*\([^)]*\)""", re.M)


def find_dupes():
    """A window of DUPE_WINDOW meaningful lines found in two files is a paste."""
    where = {}
    for p, r in list(app_sources()) + [(p, rel(p)) for g in GO_ROOTS for p in walk(g, (".go",))
                                        if not TEST_RE.search(rel(p))]:
        lines = [n for n in (_norm(ln) for ln in IMPORT_BLOCK.sub("", read(p)).splitlines()) if n]
        for i in range(len(lines) - DUPE_WINDOW + 1):
            key = hash("\n".join(lines[i:i + DUPE_WINDOW]))
            where.setdefault(key, set()).add(r)
    out = {}
    for files in where.values():
        if len(files) > 1 and frozenset(files) not in MIRRORS:
            for r in files:
                out[r] = out.get(r, 0) + 1
    return out


RULES = {
    "size": (find_size, f"over {MAX_LINES} lines — split it (C-20)"),
    "state": (find_state, f"over {MAX_STATE} useState — move state into a hook or useReducer, or split the view (C-20)"),
    "dead": (find_dead, "imported by nothing but tests — delete it, or import it where it is meant to run (C-21)"),
    "deps": (find_deps, "a dependency nothing imports — remove it from package.json (C-21)"),
    "exports": (find_exports, "exported and used by nothing outside specs — delete it (C-21)"),
    "dupes": (find_dupes, f"{DUPE_WINDOW}-line blocks pasted from another file — extract the shared part (C-27)"),
    "smells": (find_smells, "see the [name] in SMELLS for the rule and the remedy (C-24 … C-31)"),
}


def current():
    return {name: fn() for name, (fn, _) in RULES.items()}


def main(argv):
    now = current()
    base = json.loads(read(BASELINE) or "{}")

    if argv[:1] == ["--list"]:
        for k, v in sorted(now.get(argv[1], {}).items()):
            print(f"{v:6}  {k}")
        return 0

    bad, better = [], []
    for name, (_, why) in RULES.items():
        b, c = base.get(name, {}), now[name]
        for k, v in sorted(c.items()):
            if k not in b:
                bad.append(f"  {name:5}  {k} ({v}) — {why}")
            elif v > b[k]:
                bad.append(f"  {name:5}  {k} grew {b[k]} -> {v} — it is listed as debt, and debt may only shrink (C-20)")
        for k, v in b.items():
            if c.get(k, 0) < v:
                better.append((name, k))

    if argv[:1] == ["--tighten"]:
        # A rule with no baseline yet is being adopted: its findings today are
        # its starting debt. Every rule already adopted may only shrink.
        bad = [b for b in bad if b.split()[0] in base]
        if bad:
            print("refused: the tree is worse than the baseline somewhere; fix that first")
            print("\n".join(bad))
            return 1
        BASELINE.write_text(json.dumps(now, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        for name in RULES:
            if name not in base:
                print(f"adopted {name}: {len(now[name])} entr(y/ies) of starting debt")
        print(f"baseline tightened: {len(better)} entr(y/ies) improved")
        return 0

    for name in RULES:
        print(f"  {name:7}  {len(now[name]):4} listed as debt" if not any(b.startswith(f"  {name:5}") for b in bad)
              else f"  {name:7}  FAIL")
    if better:
        print(f"\n{len(better)} baseline entr(y/ies) got better — run `python3 tools/codeshape.py --tighten` to lock it in")
    if bad:
        print("\n" + "\n".join(bad))
        print(f"\n{len(bad)} violation(s)")
        return 1
    print("\n0 violation(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
