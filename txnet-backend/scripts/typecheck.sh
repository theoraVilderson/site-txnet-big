#!/usr/bin/env bash
#
# Type-check every project in the workspace.
#
# Why this exists at all: vitest transpiles through SWC and never type-checks
# (`vitest.shared.mts` says why it must be SWC), so a green test run says
# nothing about types. `tsc --noEmit` is the only thing that does.
#
# Why it is many runs and not one: a `tsconfig.spec.json` covers its spec files
# plus whatever they statically `import`, and nothing else. No project sees the
# whole workspace, so checking one and calling it done is how `billing-service`
# shipped two type errors that broke its build in September 2026 — no spec
# imported the file they were in.
#
# The configs are globbed, not listed. A project added next month is checked the
# day it gets a tsconfig, the same way `nx run-many -t test` picks up its vitest
# config (`docs/CODE-LAYOUT.md`).
#
# `*-e2e` is included on purpose. Type-checking a spec is not running it — the
# e2e tier still runs only when asked (`AGENTS.md`), and its specs are code that
# rots like any other.
#
# `--affected` narrows it to the projects Nx says the change reaches (changes
# since `$BASE`, default `HEAD`, including uncommitted and untracked files):
# a change inside one service checks that service; a change to `shared-core`
# still checks everyone, because everyone imports it. This is the default
# check (user, 2026-09-18) — the whole run is for when the graph is in doubt.
#
# Each project is one cached Nx target (`scripts/typecheck-plugin.js`), so
# a project whose inputs did not change since its last green check is replayed
# from the cache instead of re-checked, the same as `test`. On a miss, `tsc
# --incremental` keeps its build info under `node_modules/.cache/typecheck/`,
# which roughly halves a re-check (24s -> 13s for tenant-service). Measured
# 2026-09-23, 12 projects: 265s every run before; now 8s when nothing changed,
# ~33s for one edited service, ~130s for a .prisma change (all projects).
# `--skip-nx-cache` (passed through) forces a real run.
#
# Nx runs projects in parallel and prints each one's output whole when it
# finishes, so two compilers' errors never interleave; every project is checked
# even after one fails, and inside a project every config is too.
set -uo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob

# Projects at once. Each runs ~2 tsc processes (up to 1.2GB each). This
# server also serves a live site and a Telegram bot (user, 2026-09-29), so two
# cores stay free, and `test:affected` running beside this takes four (2
# projects x 2 workers): what is left, at ~2 tsc a project, never under one.
# 8 cores -> 1 job. Measured 2026-09-29 on a .prisma change (all projects,
# both commands together): 268s at the old nproc/2 with default vitest workers
# (a 19ms spec timed out at 5s), 183s capped. `docs/CODE-LAYOUT.md`.
cores=$(nproc 2>/dev/null || echo 4)
JOBS="${TYPECHECK_JOBS:-$(( (cores - 2 - 4) / 2 > 1 ? (cores - 2 - 4) / 2 : 1 ))}"
NX=node_modules/.bin/nx

case "${1:-}" in
  --project)
    # A project's configs run side by side (billing-service's spec config alone
    # is 86s; one after the other made it the whole run's critical path), their
    # output held back and printed in order so it never interleaves.
    root="${2:?--project needs a project root}"
    cache=node_modules/.cache/typecheck
    out="$(mktemp -d)"
    trap 'rm -rf "$out"' EXIT
    mkdir -p "$cache"
    configs=()
    for config in "$root"/tsconfig.{app,lib,spec}.json; do
      [ -f "$config" ] && configs+=("$config")
    done
    for config in "${configs[@]}"; do
      slug="${config//\//__}"
      { node_modules/.bin/tsc -p "$config" --noEmit --incremental \
          --tsBuildInfoFile "$cache/$slug.tsbuildinfo" > "$out/$slug.log" 2>&1
        echo $? > "$out/$slug.code"; } &
    done
    wait
    failed=0
    for config in "${configs[@]}"; do
      slug="${config//\//__}"
      if [ "$(cat "$out/$slug.code")" = 0 ]; then
        printf '  ok    %s\n' "$config"
      else
        printf '\033[1mFAIL  %s\033[0m\n' "$config"
        cat "$out/$slug.log"
        failed=1
      fi
    done
    exit $failed
    ;;
  --affected)
    shift
    exec "$NX" affected -t typecheck --base="${BASE:-HEAD}" --parallel="$JOBS" --outputStyle=static "$@"
    ;;
  *)
    exec "$NX" run-many -t typecheck --parallel="$JOBS" --outputStyle=static "$@"
    ;;
esac
