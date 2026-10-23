#!/bin/sh
# Configures the CHR over its own REST API. Every step is safe to run again,
# so a restart re-applies it to the router already in /data.
set -eu

api=http://127.0.0.1/rest
pass=${CHR_ADMIN_PASSWORD:?}

# A fresh CHR's admin has no password; after the first run it has ours.
login=""
rest() { method=$1 path=$2; shift 2; curl -fsS -m 120 -u "$login" -X "$method" -H 'Content-Type: application/json' "$api/$path" "$@"; }

wait_up() {
  i=0
  until curl -fsS -m 5 -o /dev/null -u "admin:$pass" "$api/system/identity" 2>/dev/null \
     || curl -fsS -m 5 -o /dev/null -u "admin:" "$api/system/identity" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 120 ] || { echo "chr: REST never answered" >&2; return 1; }
    sleep 5
  done
  if curl -fsS -m 5 -o /dev/null -u "admin:$pass" "$api/system/identity" 2>/dev/null; then login="admin:$pass"; else login="admin:"; fi
}

wait_up
echo "chr: REST is up"

# User Manager is a package of its own. The guest fetches it from this
# container and installs it on the reboot.
if ! rest GET user-manager -o /dev/null 2>/dev/null; then
  echo "chr: installing user-manager-${ROUTEROS_VERSION}"
  rest POST tool/fetch -d "{\"url\":\"http://10.0.2.2:8081/user-manager-${ROUTEROS_VERSION}.npk\"}" -o /dev/null
  rest POST system/reboot -d '{}' -o /dev/null || true
  sleep 20
  wait_up
fi

[ "$login" = "admin:$pass" ] || { rest POST user/set -d "{\"numbers\":\"admin\",\"password\":\"$pass\"}" -o /dev/null; login="admin:$pass"; }
# use-profiles is off on a fresh install, and then every profile and limit
# is ignored — the driver's connection test refuses such a router.
rest POST user-manager/set -d '{"enabled":"yes","use-profiles":"yes"}' -o /dev/null

# probe.sh speaks RADIUS to User Manager from this container, which the guest
# sees as 10.0.2.2.
if [ "$(rest GET 'user-manager/router?name=probe')" = "[]" ]; then
  rest PUT user-manager/router -d "{\"name\":\"probe\",\"address\":\"10.0.2.2\",\"shared-secret\":\"${CHR_RADIUS_SECRET:?}\"}" -o /dev/null
fi
echo "chr: ready, user manager enabled"
