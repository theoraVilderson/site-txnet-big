---
id: realtime
layer: platform
status: active
version: 2
keywords: [websocket, socket, realtime, ws, gateway, live updates, push, channel, subscribe, heartbeat, reconnect, live chat transport, gateway-service, txnet.v1, Sec-WebSocket-Protocol, fan-out, fanout, pub/sub, replica, events not arriving, anonymous socket, before login, pre-login, otp channel, channel token, proof, socket without signing in]
source:
  - txnet-backend/gateway-service/**
  - txnet-backend/shared-core/src/lib/realtime/**
owns_tables: []
depends_on: [identity, forward-auth, redis-keyspace]
updated: 2026-09-10
---

# realtime

**Responsibility (one sentence):** hold one WebSocket per client — signed in or
not — multiplexed into channels, and refuse every channel the connection cannot
show a claim to.
**Explicitly NOT responsible for:** deciding what is worth sending (the
producing domain does), issuing or revoking sessions (`identity`), or
authenticating the upgrade (`forward-auth` does, ADR-0030).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | changing the frames, the channel families, or the limits |
| [contract.channels.md](contract.channels.md) | changing who may hear a channel, or adding a family |
| [contract.fanout.md](contract.fanout.md) | an event does not reach a socket, or a new producer needs to send one |

## Changelog
| Date | Change |
|---|---|
| 2026-09-10 | v1 -> **v2** (ADR-0031, F-067-j): the socket is **open before anyone signs in**. The gate admits a caller with no credential, a connection may have no identity, and `otp:<channelId>` is authorized by a proof rather than by who you are. `contract.channels.md` is a §10 split |
| 2026-09-10 | F-067-i: events fan out over Redis pub/sub, one channel each, so **more than one replica is safe**. `contract.fanout.md` is a §10 split |
| 2026-09-10 | Created at F-067-h. `gateway-service`, the fifth Nx app; the upgrade is authenticated by `forward-auth` via `Sec-WebSocket-Protocol` (ADR-0030, reversing D-9) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
