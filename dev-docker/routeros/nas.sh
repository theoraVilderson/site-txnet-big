#!/bin/sh
# Makes the CHR its own NAS for probe.sh check 3: an OpenVPN server whose
# logins go to User Manager (/radius 127.0.0.1) and whose accounting also goes
# to a second entry, 10.0.2.2:1825 — this container's FreeRADIUS
# (acct-probe.conf), standing in for RADIUS_ACCT_ADDR. Safe to run again:
# each step is skipped when its row exists.
set -eu

pass=${CHR_ADMIN_PASSWORD:?}
secret=${CHR_RADIUS_SECRET:?}
rest() { method=$1 path=$2; shift 2; curl -fsS -m 120 -u "admin:$pass" -X "$method" -H 'Content-Type: application/json' "http://127.0.0.1/rest/$path" "$@"; }
missing() { [ "$(rest GET "$1")" = "[]" ]; }

if missing 'certificate?name=probe-ca'; then
  rest PUT certificate -d '{"name":"probe-ca","common-name":"probe-ca","key-usage":"key-cert-sign,crl-sign"}' -o /dev/null
  rest POST certificate/sign -d '{"number":"probe-ca"}' -o /dev/null
  rest PUT certificate -d '{"name":"probe-nas","common-name":"routeros-chr"}' -o /dev/null
  rest POST certificate/sign -d '{"number":"probe-nas","ca":"probe-ca"}' -o /dev/null
fi
missing 'ip/pool?name=probe-pool' && rest PUT ip/pool -d '{"name":"probe-pool","ranges":"10.9.0.10-10.9.0.200"}' -o /dev/null
missing 'ppp/profile?name=probe' && rest PUT ppp/profile -d '{"name":"probe","local-address":"10.9.0.1","remote-address":"probe-pool"}' -o /dev/null
missing 'interface/ovpn-server/server?name=probe' && rest PUT interface/ovpn-server/server \
  -d '{"name":"probe","certificate":"probe-nas","require-client-certificate":"no","default-profile":"probe","disabled":"no"}' -o /dev/null
missing 'user-manager/router?address=127.0.0.1' && rest PUT user-manager/router \
  -d "{\"name\":\"nas-self\",\"address\":\"127.0.0.1\",\"shared-secret\":\"$secret\"}" -o /dev/null
missing 'radius?address=127.0.0.1' && rest PUT radius -d "{\"address\":\"127.0.0.1\",\"secret\":\"$secret\",\"service\":\"ppp\"}" -o /dev/null
missing 'radius?address=10.0.2.2' && rest PUT radius \
  -d "{\"address\":\"10.0.2.2\",\"secret\":\"$secret\",\"service\":\"ppp\",\"authentication-port\":\"1824\",\"accounting-port\":\"1825\"}" -o /dev/null
rest POST ppp/aaa/set -d '{"use-radius":"yes","accounting":"yes","interim-update":"20s"}' -o /dev/null

if [ ! -f /etc/probe.ovpn ]; then
  rest POST certificate/export-certificate -d '{"numbers":"probe-ca","file-name":"probe-ca"}' -o /dev/null
  {
    printf 'client\ndev tun\nproto tcp-client\nremote 127.0.0.1 1194\nnobind\nroute-nopull\n'
    printf 'auth SHA1\ncipher AES-128-CBC\ndata-ciphers AES-128-CBC\nverify-x509-name routeros-chr name\n<ca>\n'
    rest GET file/probe-ca.crt | jq -r .contents
    printf '</ca>\n'
  } > /etc/probe.ovpn
fi

[ -f /tmp/acct-probe.pid ] && kill -0 "$(cat /tmp/acct-probe.pid)" 2>/dev/null || radiusd -n acct-probe -d /etc/raddb
