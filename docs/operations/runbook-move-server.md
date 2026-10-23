---
id: runbook-move-server
status: active
updated: 2026-10-23
---

# Runbook — move the platform to another server

A planned move to another server or datacenter, with every byte of state:
Postgres, Redis (sessions, bot sign-ins), RabbitMQ's queued messages,
uploaded files, runtime-written text, the three keys, the env files, the TLS
certificates, both backup repositories, and the monitoring history. Hosting
`contract.md` H23; the tool is `scripts/move/server_move.py`.

For a server that is already **lost**, this does not apply: restore from the
backups, `runbook-restore-database.md` 3c.

```bash
MOVE="python3 scripts/move/server_move.py --stack dev --to root@<new server> --monitor-project txnet_monitor_dev"
# prod: --stack prod. Drop --monitor-project to leave the history behind.
```

## Symptom

None: this is planned work. The platform is down for the **cutover** only.
Measured 2026-10-23 on dev: the database volume's content digest 10s
(612 MB), the backup repository's name-and-size digest 0.2s (4.6 GB; a content
digest was 116s), the 240 tables' counts 3s. **Not yet rehearsed between two
real servers**: time the first one and write the figure here.

## How it pages

Nothing pages; the tool stops on the first problem and says which server
serves. `PgArchiveFailing` firing before you start means the cutover will stop
at the WAL flush: fix that first.

## First 3 checks

1. **The new server.** Docker and rsync installed; on prod, its origin firewall
   (`python3 scripts/edge/cloudflare_firewall.py apply` then `install`, run
   there; EDGE-1-h); this server's root can
   `ssh root@<new>` with a key (BatchMode, no password); the repo checked out
   **at the same path and the same commit**; NTP on (the tool refuses a clock
   more than 5s apart: Redis expiries and JWTs are absolute instants).
2. **`$MOVE check`** lists what moves and every blocker. Zero blockers before
   anything else.
3. **RabbitMQ runs as `rabbit@localhost`** (`data.yml`). `check` refuses
   otherwise, because a queue lives under its node's name and the new
   server would start empty. Done on dev 2026-10-23. Elsewhere, once, at a quiet
   moment: save every queued message through the management API (`get`,
   `ackmode=ack_requeue_true`), `$COMPOSE up -d rabbitmq`, restart the
   services that exited on the closed connection (on dev, `dev-serve` waits for
   a file change instead: `docker restart` worker, metering, ai, billing), wait
   for the queues to be declared again, publish the saved messages back to the
   same queues. A delayed message restarts its window: at most an hour late.

## Mitigation

### 1. Presync — while the platform serves

```bash
$MOVE presync
```

Copies the env files and keys first (the new server's compose needs them),
builds and pulls the images there, then copies every volume and repository.
The copy is not consistent and does not have to be: it moves the bulk, so the
cutover moves only what changed. Repeat it as often as you like; run it once
more right before the cutover.

### 2. Cutover — the platform is down from here

```bash
$MOVE cutover
```

In order, stopping at the first failure:

1. stops every service but `main-db`, `memory-data`, `rabbitmq` (nothing writes);
2. pushes the last WAL segment into the archive and waits for it;
3. reads the figures: every table's row count, Redis keys with and without a
   TTL, queued messages; then stops the data services cleanly (Redis writes its
   AOF, Postgres checkpoints);
4. final copy: volumes compared by content (`--checksum`), backup repositories by
   name and size (their files are written once); the keys and env again;
5. **byte check**: one digest per directory on both servers. A mismatch stops
   here: nothing started on the new server, run rollback;
6. writes `.moved-to` here: the compose wrappers refuse `up`/`start` beside it
   (`scripts/moved-guard.sh`), so two servers never archive into one repository;
7. starts the data services there and reads the figures again. Tables must match
   exactly, keys with no TTL exactly, keys with a TTL and queued messages may only
   be fewer (expired during the move), never zero and never more;
8. starts everything that ran here; starts monitoring if it ran; starts a full
   pgBackRest backup there as the new baseline.

### 3. Switch the address

The new server serves only once Cloudflare sends traffic to it. Every proxied
A record on the old address moves to the new one, proxy state kept:

```bash
ENV_FILE=.env.prod python3 scripts/edge/edge_zone.py repoint <old address> <new address>
```

Check: sign in on the panel (your session survives: Redis moved), open one
`/sub` link, send the bot `/start`.

### Rollback — before the switch only

```bash
$MOVE rollback
```

Stops the stack there, removes `.moved-to`, starts here exactly what ran
before. After the switch, anything written on the new server would be lost.
Move back instead, with this runbook in the other direction.

## Root-cause notes

- **Allowlists that name the old address**: VPN panels' API firewalls
  (network-service calls them from the new address), RADIUS clients on
  RouterOS/IBSng, a payment gateway that registers the server's IP, the SMS
  provider. Add the new address before the switch; remove the old one a day after.
- The old server keeps its copy. Keep it, stopped, for a week; then delete
  the volumes and `.moved-to` together.
- What is not moved, on purpose: `pg_socket`, `locale_cache`, the translator
  models (rebuilt or downloaded again), images (built from the commit).
  A new compose volume stops `check` until it is classified in
  `scripts/move/move_plan.py`.

## Owner

`hosting` (`docs/platform/hosting/`). Built 2026-10-23 (OPS-1-ac). Rehearsed
on dev: check 3 (RabbitMQ's node name), and every reader of `check` and `cutover` on the
live stack; the copy between two servers is not yet rehearsed.
