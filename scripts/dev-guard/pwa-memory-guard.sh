#!/usr/bin/env bash
# Restart the dev panel (`next dev`) before it reaches its memory cap.
#
# Why: Turbopack's memory in `next dev` grows for hours and is not JS heap, so
# Next's own heap-based restart never sees it. At the container's cap the
# server stalls reclaiming memory (2026-10-19: 71706 hits, ~15% of the time
# stalled) and pages load slowly, then suddenly fine. SURFACES.md flow
# `panel-dev-slow-memory`. Dev stack only — it touches one container by name.
#
# Run by pwa-memory-guard.timer every 10 minutes; `--dry-run` only reports.
set -euo pipefail

CONTAINER="${PWA_CONTAINER:-txnet-dev-site-pwa}"
# Restart at this share of the cap: past it, reclaim stalls begin.
THRESHOLD_PERCENT="${PWA_MEMORY_THRESHOLD_PERCENT:-85}"
# Seconds `docker restart` waits before killing.
STOP_TIMEOUT_SEC=20

id=$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null) || { echo "$CONTAINER: not running, nothing to do"; exit 0; }
cgroup="/sys/fs/cgroup/system.slice/docker-${id}.scope"
max=$(cat "$cgroup/memory.max")
[ "$max" = "max" ] && { echo "$CONTAINER: no memory cap, nothing to guard"; exit 0; }
current=$(cat "$cgroup/memory.current")
percent=$(( current * 100 / max ))

echo "$CONTAINER: $(( current / 1048576 )) MiB of $(( max / 1048576 )) MiB (${percent}%), restart at ${THRESHOLD_PERCENT}%"
if [ "$percent" -ge "$THRESHOLD_PERCENT" ] && [ "${1:-}" != "--dry-run" ]; then
  echo "$CONTAINER: over the threshold, restarting"
  docker restart -t "$STOP_TIMEOUT_SEC" "$CONTAINER" >/dev/null
fi
