#!/bin/sh
# The facts F-1601-e proved on this router, re-proved on demand:
#   docker exec txnet-dev-routeros-chr sh /usr/local/bin/probe.sh
# Each prints `ok:` or `FAIL:`; the exit status is the number of failures.
# It makes its own users (probe-*) and leaves the router as it found it,
# except the NAS of check 3, which stays configured for the next run.
set -u

pass=${CHR_ADMIN_PASSWORD:?}
secret=${CHR_RADIUS_SECRET:?}
api=http://127.0.0.1/rest
failures=0

rest() { method=$1 path=$2; shift 2; curl -sS -m 120 -u "admin:$pass" -X "$method" -H 'Content-Type: application/json' "$api/$path" "$@"; }
ok() { echo "ok: $*"; }
fail() { echo "FAIL: $*"; failures=$((failures + 1)); }

# auth USER PASSWORD -> Access-Accept | Access-Reject, as User Manager answers.
auth() {
  printf 'User-Name = %s\nUser-Password = %s\nMessage-Authenticator = 0x00\n' "$1" "$2" |
    radclient -x 127.0.0.1:1812 auth "$secret" 2>&1 | grep -o 'Received Access-[A-Za-z]*' | cut -d' ' -f2
}

# session USER ID UP DOWN: one closed session, as a NAS reports it.
session() {
  for kind in Start Stop; do
    printf 'User-Name = %s\nAcct-Status-Type = %s\nAcct-Session-Id = %s\nNAS-IP-Address = 10.0.2.2\nAcct-Input-Octets = %s\nAcct-Output-Octets = %s\n' \
      "$1" "$kind" "$2" "$3" "$4" | radclient -q 127.0.0.1:1813 acct "$secret"
  done
}

# chain NAME LIMIT: a limitation and a profile of that name, linked.
chain() {
  rest PUT user-manager/limitation -d "{\"name\":\"$1\",\"transfer-limit\":\"$2\",\"reset-counters-interval\":\"disabled\"}" -o /dev/null
  rest PUT user-manager/profile -d "{\"name\":\"$1\",\"validity\":\"unlimited\",\"starts-when\":\"assigned\",\"price\":\"0\"}" -o /dev/null
  rest PUT user-manager/profile-limitation -d "{\"profile\":\"$1\",\"limitation\":\"$1\"}" -o /dev/null
}

link_id() { rest GET "user-manager/user-profile?user=$1&profile=$2" | jq -r '.[0][".id"]'; }

cleanup() {
  for u in probe-u; do
    for id in $(rest GET "user-manager/user-profile?user=$u" | jq -r '.[][".id"]'); do rest DELETE "user-manager/user-profile/$id"; done
    for id in $(rest GET "user-manager/session?user=$u" | jq -r '.[][".id"]'); do rest DELETE "user-manager/session/$id"; done
    rest DELETE "user-manager/user/$u" >/dev/null 2>&1
  done
  for p in probe-own probe-ours; do
    for id in $(rest GET "user-manager/profile-limitation?profile=$p" | jq -r '.[][".id"]'); do rest DELETE "user-manager/profile-limitation/$id"; done
    rest DELETE "user-manager/profile/$p" >/dev/null 2>&1
    rest DELETE "user-manager/limitation/$p" >/dev/null 2>&1
  done
}
cleanup

# 1. transfer-limit counts from the profile link, not the user's lifetime
#    (ADR-0160 decision 9). 600 MB used on the user's own profile, then
#    adopted onto ours at 500 MB: a lifetime counter would refuse the login.
rest PUT user-manager/user -d '{"name":"probe-u","password":"probe-p"}' -o /dev/null
chain probe-own 1000000000
chain probe-ours 500000000
rest PUT user-manager/user-profile -d '{"user":"probe-u","profile":"probe-own"}' -o /dev/null
session probe-u probe-1 300000000 300000000
rest DELETE "user-manager/user-profile/$(link_id probe-u probe-own)"
rest PUT user-manager/user-profile -d '{"user":"probe-u","profile":"probe-ours"}' -o /dev/null
[ "$(auth probe-u probe-p)" = Access-Accept ] \
  && ok "adopted at 500 MB after 600 MB used: accepted, the counter starts at the link" \
  || fail "adopted at 500 MB after 600 MB used: refused, the counter is the lifetime"
session probe-u probe-2 300000000 300000000
[ "$(auth probe-u probe-p)" = Access-Reject ] \
  && ok "600 MB on the adopted link against 500 MB: refused, the limit holds" \
  || fail "600 MB on the adopted link against 500 MB: accepted, the limit does not hold"
rest DELETE "user-manager/user-profile/$(link_id probe-u probe-ours)"
rest PUT user-manager/user-profile -d '{"user":"probe-u","profile":"probe-ours"}' -o /dev/null
[ "$(auth probe-u probe-p)" = Access-Accept ] \
  && ok "the same profile linked again: accepted, a new link starts from zero (F-027-du-b)" \
  || fail "the same profile linked again: refused, a new link keeps the old count"

# 2. user/monitor takes row ids, answers lifetime totals, and refuses a name.
id=$(rest GET 'user-manager/user?name=probe-u' | jq -r '.[0][".id"]')
total=$(rest POST user-manager/user/monitor -d "{\"numbers\":\"$id\",\"once\":\"\"}" | jq -r '.[0]["total-download"]')
[ "$total" = 600000000 ] && ok "monitor by id: total-download $total, the lifetime" || fail "monitor by id answered total-download $total"
rest POST user-manager/user/monitor -d '{"numbers":"probe-u","once":""}' | grep -q '"error":404' \
  && ok "monitor by name: 404" || fail "monitor by name answered"
cleanup

# 3. The NAS sends a session's accounting only to the /radius entry that
#    logged it in (User Manager), never to a second one — the second hears
#    Accounting-On and nothing else, though it answers as our receiver would.
#    So no RADIUS_ACCT_ADDR hears a User Manager deployment's usage
#    (F-027-ag-b reads it from the router instead).
sh "$(dirname "$0")/nas.sh" || fail "the NAS could not be set up"
printf 'User-Name = stand-in\nAcct-Status-Type = Start\nAcct-Session-Id = stand-in\n' |
  radclient -q 127.0.0.1:1825 acct "$secret" && grep -q 'stand-in' /tmp/radacct.detail \
  && ok "the second /radius entry answers and records accounting sent to it" \
  || fail "the second /radius entry does not answer — is acct-probe up?"
: > /tmp/radacct.detail
rest PUT user-manager/user -d '{"name":"probe-u","password":"probe-p"}' -o /dev/null
chain probe-ours 0
rest PUT user-manager/user-profile -d '{"user":"probe-u","profile":"probe-ours"}' -o /dev/null
printf 'probe-u\nprobe-p\n' > /tmp/probe-auth
rm -f /tmp/probe-ovpn.log
openvpn --config /etc/probe.ovpn --auth-user-pass /tmp/probe-auth --daemon --log /tmp/probe-ovpn.log
i=0; until grep -q 'Initialization Sequence Completed' /tmp/probe-ovpn.log 2>/dev/null || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done
sleep 25 # past one interim-update (20s, nas.sh)
ping -c 5 -s 1000 -I tun0 10.9.0.1 >/dev/null 2>&1
pkill openvpn
i=0; until rest GET 'user-manager/session?user=probe-u' | grep -q 'stop' || [ "$i" -ge 20 ]; do i=$((i + 1)); sleep 1; done
status=$(rest GET 'user-manager/session?user=probe-u' | jq -r '.[0].status')
case "$status" in
  *start*interim*stop* | *start*stop*interim*) ok "User Manager got the whole session: $status" ;;
  *) fail "User Manager's session reads '$status', want start, interim and stop" ;;
esac
grep -q 'Acct-Status-Type = \(Start\|Interim-Update\|Stop\)' /tmp/radacct.detail \
  && fail "the second /radius entry got session accounting — RouterOS changed; revisit F-027-ag-b" \
  || ok "the second /radius entry got none of the session's accounting"
cleanup

exit "$failures"
