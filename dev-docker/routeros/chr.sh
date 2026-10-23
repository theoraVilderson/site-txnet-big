#!/bin/sh
# Boots the CHR under qemu and configures it once it answers (bootstrap.sh).
# The disk lives in /data, so User Manager's package, its users and its usage
# survive a restart; delete the volume to start from a clean router.
set -eu

disk=/data/chr-${ROUTEROS_VERSION}.img
[ -f "$disk" ] || cp /opt/routeros/chr.img "$disk"

# The guest fetches its User Manager package from here: slirp shows this
# container to the guest as 10.0.2.2.
httpd -p 127.0.0.1:8081 -h /opt/routeros

# slirp forwards what the probes and the driver reach: REST (80), User
# Manager's RADIUS (1812/1813, which the guest sees arriving from 10.0.2.2)
# and the NAS's OpenVPN server (1194). The guest's own packets leave through
# this container, so its accounting reaches network-service as from here.
qemu-system-x86_64 -nographic -m 256 -smp 1 -accel tcg \
  -drive "file=$disk,format=raw,if=virtio" \
  -netdev "user,id=wan,hostfwd=tcp::80-:80,hostfwd=udp::1812-:1812,hostfwd=udp::1813-:1813,hostfwd=tcp::1194-:1194" \
  -device virtio-net-pci,netdev=wan &
qemu=$!

trap 'kill "$qemu"' TERM INT
/bin/sh /usr/local/bin/bootstrap.sh || echo "chr: bootstrap failed, the router is up unconfigured" >&2
wait "$qemu"
