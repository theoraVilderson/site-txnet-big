---
id: runbook-move-cluster
status: active
updated: 2026-10-31
---

# Runbook — move production's cluster to another server

Production's k3s cluster moves to a new server with **one writer at any
moment**: the old cluster sends nothing before the new one may, and the new one
sends nothing until the old one is fenced. Hosting `contract.nodes.md` K21; the
tool is `scripts/move/cluster_move.py`, run on the build host from the repo
root. A compose server moves with `runbook-move-server.md` instead.

```bash
MOVE="python3 scripts/move/cluster_move.py"
FROM="--from root@2.144.31.149 --from-key ~/.ssh/txnet_test_ed25519"
TO="--to root@<new> --to-key ~/.ssh/<its key>"
```

## Rehearsal — production only read, DNS untouched

```bash
$MOVE rehearse $FROM $TO
for s in check mute install deploy bundle restore; do $MOVE $s || break; done
$MOVE status          # figures: each step's seconds
```

`bundle` takes production's newest nightly bundle; nothing on production
stops. The new server stays **mute** afterwards: leave it so until the real
move restores over it.

Rehearsed 2026-10-31: bundle 98s on production (13 MB), transfer 3s, restore
187s — **~8 minutes down** with the stop and the open. Install 386s and deploy
245s happen while production still runs.

Downtime estimate = `stop` (scale to zero, from the twin) + a bundle made now
(the nightly's duration in `journalctl -u txnet-backup`) + `bundle_total_s`
less its make + `restore_s` + `open`.

## The real move — a quiet hour, the user approving each step

Before: the panels, RADIUS, the payment gateway and SMS allow the new address;
mytxnet.ir stays untouched without the user's word (`MOVE_LIVE_DOMAIN_OK`).

```bash
$MOVE move $FROM $TO
$MOVE check; $MOVE mute; $MOVE install; $MOVE deploy   # platform still up
$MOVE stop        # down from here
$MOVE bundle; $MOVE restore
$MOVE fence       # old: k3s stopped and disabled, data kept, marker written
$MOVE open        # new: unmuted, the bot re-registers
$MOVE repoint     # Cloudflare and Arvan to the new address
```

Each step refuses out of order and says why; run it again after fixing that.

## Going back

Before `open`: the old data is untouched. On the old server, with the user's
word: `rm /etc/txnet/moved-to && systemctl enable --now k3s`, then scale the
workloads back to their `txnet.io/replicas-before-move` annotations; re-mute
or stop the new server first. After `open` the two have diverged: going back
is a new move in the other direction.
