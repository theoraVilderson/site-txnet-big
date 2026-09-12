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
# Run in parallel, because serially this is five minutes and a five-minute gate
# is one that gets skipped. Each run's output is captured and replayed whole
# afterwards, so parallelism never interleaves two compilers' errors into
# something unreadable. Every config is checked even after one fails: one pass
# should show the whole picture, not the first project alphabetically.
set -uo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob

JOBS="${TYPECHECK_JOBS:-$(nproc 2>/dev/null || echo 4)}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

mapfile -t CONFIGS < <(printf '%s\n' */tsconfig.app.json */tsconfig.lib.json */tsconfig.spec.json | sort)
if [ ${#CONFIGS[@]} -eq 0 ]; then
  echo "typecheck: no tsconfig found — is this the workspace root?" >&2
  exit 1
fi

printf 'type-checking %d project(s), %s at a time\n' "${#CONFIGS[@]}" "$JOBS"

check_one() {
  local config="$1"
  node_modules/.bin/tsc -p "$config" --noEmit > "$OUT/${config//\//__}.log" 2>&1
  echo $? > "$OUT/${config//\//__}.code"
}
export -f check_one
export OUT

printf '%s\n' "${CONFIGS[@]}" | xargs -P "$JOBS" -I{} bash -c 'check_one "$@"' _ {}

failed=()
for config in "${CONFIGS[@]}"; do
  slug="${config//\//__}"
  code="$(cat "$OUT/$slug.code" 2>/dev/null || echo 1)"
  if [ "$code" = "0" ]; then
    printf '  ok    %s\n' "$config"
  else
    failed+=("$config")
    printf '\n\033[1mFAIL  %s\033[0m\n' "$config"
    cat "$OUT/$slug.log"
  fi
done

echo
if [ ${#failed[@]} -eq 0 ]; then
  printf 'type-check passed (%d projects)\n' "${#CONFIGS[@]}"
  exit 0
fi
printf 'type-check FAILED in %d of %d project(s):\n' "${#failed[@]}" "${#CONFIGS[@]}"
printf '  %s\n' "${failed[@]}"
exit 1
