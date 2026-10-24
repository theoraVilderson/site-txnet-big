---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: more than one node

K1–K16 run the cluster on one k3s server. This file adds a node to it and takes
one away (ADR-0164, OPS-1-o-q). K18 (a move between servers) and H22 (the
Postgres standby) build on it. Code: `scripts/k8s-add-node.sh`,
`scripts/edge/k3s_ports.py`, `k8s/k3s/config.yaml`, `tools/k8srender/` (the pin).

**K17 — A second node.**

- **Transport.** flannel `wireguard-native` on every path between nodes
  (user, 2026-10-24), set once in the server's `k8s/k3s/config.yaml`; agents
  follow it. Over a provider's private network, `NODE_PRIVATE_IP` and
  `SERVER_PRIVATE_IP` make the agent's `node-ip`/`flannel-iface` the private
  address and `node-external-ip` the public one; unset, both ends use their
  public address. One setup for both: a node that changes provider changes an
  address, never the backend. A server switched to WireGuard after its install
  restarts k3s and drops `flannel.1`.
- **One command, from the server.** `k8s-add-node.sh join <host> [port]` runs
  as root on the k3s server node from the checkout and reaches the other server
  over SSH as root; nothing is installed there but k3s and K13's two scripts.
  `check` reports what `join` would refuse and changes nothing; `remove` drains
  and deletes the node, uninstalls k3s and K13's units there, and takes its
  address out of the peers.
- **Refused before anything changes**, every reason reported at once: k3s
  already there; the dev stack running (ADR-0147 point 6); under 4096 MiB of
  memory or 30 GiB free under `/var/lib`; no `wireguard` module; 80 or 443
  held, since the LoadBalancer binds both on every node. The round trip is
  measured: over 10 ms the node is a standby, never a worker, since a pod there
  pays it on every store query. What else listens there is printed. The floors
  are named constants; `MIN_NODE_MEM_MIB`/`MIN_NODE_DISK_GIB` lower them only for
  a trial node that will carry no release.
- **K13 between nodes.** `/etc/txnet/k3s-peers` holds the other nodes'
  addresses, one per line; `k3s_ports.py apply` puts an `ACCEPT` per peer ahead
  of the chain's `DROP`, each family on its own tool. A name is refused, since
  iptables resolves it once. The chain also takes 51820–51821/udp (WireGuard's
  IPv4/IPv6 listeners). The server lists the node, the node lists the server;
  on a private interface nothing is filtered (K13 drops on the public one).
- **What the node gets.** The server's own `k3s` binary, checked against
  K1's pin, `install.sh` at the same tag, the node token, the server's
  `registries.yaml` (K14), staged in a 0700 directory removed after the install;
  no proxy reaches the agent's unit, as on the server.
- **State stays on the data node.** The server registers with
  `txnet.io/data=true` (`node-label` in `k8s/k3s/config.yaml`; `join` sets it
  too, for a server installed before). The render gives that `nodeSelector` to
  every pod holding a claim or a host path, DaemonSets aside (`DATA_NODE_LABEL`,
  `holds_node_state`): a `local-path` volume binds on the node of its first pod
  and cannot follow it. That is the stores, Traefik (`letsencrypt`),
  `object_storage`'s five users, locale-service, the translators, and
  Prometheus, Loki, Grafana, node-exporter; on the main stack the other 15 are
  free. `deploy` and `rollback` refuse to apply anything while no node carries
  the label. One label, held equal in its four homes by `k8s_render_test.py`.
- **No ReadWriteMany (K7, user 2026-10-24).** `object_storage` stays one
  `ReadWriteOnce` claim, its users pinned with it, until F-018-m2's S3 driver
  removes the shared disk; NFS (a second single point) and Longhorn (~1 GiB a
  node of K19's fit) were rejected. `locale_cache` is each pod's own
  `emptyDir`: every service writes only its own `<scope>.<lang>.json` (H17), and
  a pod started while locale-service is down stays unready while the old one
  serves (`maxUnavailable: 0`).
- **Cloudflare reaches the data node only (user, 2026-10-24).** While the
  stores live there, a second entry adds no availability, only a dead address
  Cloudflare's free plan would keep sending visitors to; and Traefik's ACME
  HTTP challenge keeps one `acme.json`, so one Traefik. The zone's records name
  the data node; `join` puts O7 (`cloudflare_firewall.py`, from the server's
  last good list) on the node before k3s, since svclb binds 80/443 there too.
  Reaching both nodes is OPS-1-o-r's, with the standby, through
  `edge_zone.py repoint`.
- **The dev host is the second node, and a worker (user, 2026-10-24/25).** It
  stays an agent past the trial; the stateless release pods run on both nodes
  (1–2 ms apart, under K17's 10 ms), the stores stay on the data node, and the
  dev host also builds (R4). Its dev stack, site and bot stay stopped while it is
  joined. Its 21 GiB free is under `MIN_NODE_DISK_GIB`: images pulled there too
  narrow it, so room is freed before OPS-1-y's standby lands.

Proven 2026-10-24, the dev host joining the test server as a trial (the user set
ADR-0147 point 6 aside for it; the dev stack, site and bot stopped first).
`check` refused it for the dev stack, 21 GiB free and 80/443 held, and passed
once they were stopped, with the disk floor at 20 for the trial. After `join`,
both nodes Ready in seconds at 1–2 ms; a pod on the new node resolved through
CoreDNS on the server and pinged a pod there in 2.3 ms; the route to the
server's pods left by `flannel-wg`, with no `flannel.1` on either node; the
server reached the node's kubelet through the peer `ACCEPT`.
