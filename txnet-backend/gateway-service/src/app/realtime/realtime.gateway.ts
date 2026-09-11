import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, type WebSocket } from 'ws';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';
import { channelRefusal, type ChannelProofs } from './channel';
import { RealtimeFanout } from './fanout';
import { admissionFrom, clientAddressOf, type Admission } from './identity';
import {
  CloseCode,
  parseClientFrame,
  REALTIME_SUBPROTOCOL,
  type ClientFrame,
  type RefusalCode,
} from './protocol';
import {
  ConnectionRegistry,
  send,
  type Connection,
} from './connection.registry';

/**
 * The WebSocket gateway: one socket per client, multiplexed into channels
 * (F-067-h, D-9, ADR-0031).
 *
 * **One connection, many channels** is the shape the whole row turns on. The
 * alternative — a socket per feature — costs a TCP connection, a TLS
 * handshake and an upgrade *per page section*, and browsers cap concurrent
 * connections per origin, so it degrades exactly when a page is busiest. Here
 * a page subscribes to what it needs and a user moving between pages keeps the
 * socket it already had.
 *
 * Authentication is not this class's job. Traefik runs the upgrade request
 * through `forward-auth` like every other request, and this process reads the
 * decision that comes back (`identity.ts`). That is what makes owning a
 * realtime gateway defensible rather than expensive: there is no second token
 * model, no second session store, and a revoked session is revoked here for
 * the same reason it is revoked everywhere.
 *
 * **The decision has two shapes since ADR-0031.** A socket here is the
 * live-data transport, held open from the moment a page loads, and the OTP
 * delivery result is pushed onto one during registration — before any session
 * exists. So the gate admits a caller with no credential as *anonymous*, and
 * such a connection may hear only what it can prove per subscription. What did
 * not change is the part that matters: the gate is still the only thing that
 * decides, a presented credential that fails is still a refusal, and a
 * signed-in socket is exactly as authenticated as it was before.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly wss: WebSocketServer;

  private readonly path: string;
  private readonly heartbeatMs: number;
  private readonly recheckMs: number;
  private readonly maxSubscriptions: number;
  private readonly maxPerUser: number;
  private readonly maxPerAddress: number;
  private readonly maxFrameBytes: number;
  /** How `channel.ts` asks Redis about a proof it was shown. */
  private readonly proofs: ChannelProofs;

  private heartbeatTimer?: NodeJS.Timeout;
  private recheckTimer?: NodeJS.Timeout;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly fanout: RealtimeFanout,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.path = config.get<string>('REALTIME_PATH')!;
    this.heartbeatMs = config.get<number>('REALTIME_HEARTBEAT_MS')!;
    this.recheckMs = config.get<number>('REALTIME_SESSION_RECHECK_MS')!;
    this.maxSubscriptions = config.get<number>('REALTIME_MAX_SUBSCRIPTIONS')!;
    this.maxPerUser = config.get<number>('REALTIME_MAX_CONNECTIONS_PER_USER')!;
    this.maxPerAddress = config.get<number>('REALTIME_MAX_CONNECTIONS_PER_IP')!;
    this.maxFrameBytes = config.get<number>('REALTIME_MAX_FRAME_BYTES')!;

    // The store side of a proof, kept behind the interface `channel.ts`
    // declares so the authorization rule stays testable without a Redis.
    this.proofs = {
      otpChannelToken: (channelId) =>
        this.redis.get(RedisKeys.otpChannel(channelId)),
    };

    this.wss = new WebSocketServer({
      // The upgrade is handled by hand (`attach` below) so an unauthenticated
      // one can be refused with a real HTTP status before any WebSocket
      // exists. With `ws` owning the server the only way to refuse is to
      // accept and then close, which tells a client far less and costs a
      // handshake.
      noServer: true,
      maxPayload: this.maxFrameBytes,
      // Select the marker, never the token. The chosen subprotocol is echoed
      // in `Sec-WebSocket-Protocol` on the 101, and the second entry of that
      // list is the access JWT — echoing it would write the credential into a
      // response header for no reason at all.
      handleProtocols: (offered) =>
        offered.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false,
    });
  }

  /**
   * Take over `upgrade` on the HTTP server Nest is already listening with.
   *
   * Sharing one port and one process with `/health` is deliberate: Traefik
   * routes to a service by port, and a second port would mean a second
   * service definition for something that is one deployable.
   */
  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));

    // Start hearing what other processes fanned out (F-067-i) at the same
    // moment this replica starts accepting sockets.
    this.fanout.listen();

    this.heartbeatTimer = setInterval(() => this.beat(), this.heartbeatMs);
    this.recheckTimer = setInterval(
      () => void this.recheckSessions(),
      this.recheckMs,
    );
    this.logger.log(
      `realtime gateway on ${this.path} ` +
        `(heartbeat ${this.heartbeatMs}ms, session re-check ${this.recheckMs}ms, ` +
        `${this.maxSubscriptions} channels x ${this.maxPerUser} sockets per user, ` +
        `${this.maxPerAddress} anonymous sockets per address)`,
    );
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== this.path) {
      return refuse(socket, 404, 'Not Found');
    }

    const admitted = admissionFrom(req);
    if (!admitted) {
      // The gate said nothing at all — not "signed in", not "anonymous".
      // Either it did not run or its headers were not forwarded. Both are
      // configuration failures and the safe reading of both is that no
      // decision was made, which is not the same as a decision of "nobody"
      // (`identity.ts`).
      this.logger.warn('upgrade with no answer from the gate — refusing');
      return refuse(socket, 401, 'Unauthorized');
    }

    const address = clientAddressOf(req);
    // The connection cap, checked before the handshake rather than after: a
    // client in a reconnect loop otherwise pays for a full WebSocket
    // handshake per attempt, and so does this process. Which cap applies
    // depends on whether there is a user to count against — an anonymous
    // connection is bounded by its address, the only key it has.
    if (admitted.identity) {
      if (this.registry.countForUser(admitted.identity.userId) >= this.maxPerUser) {
        this.logger.warn(`user ${admitted.identity.userId} is at the connection cap`);
        return refuse(socket, 429, 'Too Many Requests');
      }
    } else if (this.registry.countForAddress(address) >= this.maxPerAddress) {
      this.logger.warn(`${address} is at the anonymous connection cap`);
      return refuse(socket, 429, 'Too Many Requests');
    }

    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.open(ws, admitted, address),
    );
  }

  private open(ws: WebSocket, admitted: Admission, address: string): void {
    const connection: Connection = {
      id: randomUUID(),
      identity: admitted.identity,
      address,
      socket: ws,
      subscriptions: new Set(),
      alive: true,
    };
    this.registry.add(connection);

    ws.on('message', (data) => this.onMessage(connection, data.toString()));
    ws.on('pong', () => {
      connection.alive = true;
    });
    ws.on('close', () => this.drop(connection));
    // Without this listener `ws` re-emits a socket error as an uncaught
    // exception on the process — one client's broken connection would stop
    // every other client's.
    ws.on('error', (err) =>
      this.logger.warn(`connection ${connection.id}: ${err.message}`),
    );

    send(connection, {
      type: 'welcome',
      connectionId: connection.id,
      userId: admitted.identity ? admitted.identity.userId : null,
      heartbeatMs: this.heartbeatMs,
      maxSubscriptions: this.maxSubscriptions,
    });
  }

  private onMessage(connection: Connection, raw: string): void {
    const parsed = parseClientFrame(raw);
    if (!parsed.frame) {
      send(connection, { type: 'error', code: parsed.code });
      return;
    }
    void this.handle(connection, parsed.frame);
  }

  /**
   * Handle one frame.
   *
   * Asynchronous since F-067-j: authorizing a proof-bearing channel needs a
   * Redis read, so `subscribe` and `resume` answer after a round trip. The
   * answer to one frame is not ordered against the answer to another and
   * never was — the client matches an answer to its request by the channel
   * name it carries.
   */
  private async handle(connection: Connection, frame: ClientFrame): Promise<void> {
    switch (frame.type) {
      case 'ping':
        send(connection, { type: 'pong' });
        return;

      case 'subscribe': {
        const refusal = await this.trySubscribe(
          connection,
          frame.channel,
          frame.proof ?? null,
        );
        send(
          connection,
          refusal
            ? { type: 'error', code: refusal, channel: frame.channel }
            : { type: 'subscribed', channel: frame.channel },
        );
        return;
      }

      case 'unsubscribe':
        this.registry.unsubscribe(connection, frame.channel);
        void this.fanout.reconcile(frame.channel);
        send(connection, { type: 'unsubscribed', channel: frame.channel });
        return;

      case 'resume': {
        const channels: string[] = [];
        const refused: string[] = [];
        for (const channel of frame.channels) {
          // No proof travels on a `resume`, so a proof-bearing channel is
          // refused here and the client re-subscribes to it explicitly — it
          // is holding the proof already (`protocol.ts`).
          if (await this.trySubscribe(connection, channel, null)) {
            refused.push(channel);
          } else {
            channels.push(channel);
          }
        }
        send(connection, { type: 'resumed', channels, refused });
        return;
      }
    }
  }

  /** Returns a refusal code, or `null` when the subscription was made. */
  private async trySubscribe(
    connection: Connection,
    channel: string,
    proof: string | null,
  ): Promise<RefusalCode | null> {
    let refusal: RefusalCode | null;
    try {
      refusal = await channelRefusal(
        { identity: connection.identity, channel, proof },
        this.proofs,
      );
    } catch (err) {
      // A store that cannot be reached is not evidence that the client may
      // hear the channel. This is the same rule the session re-check applies
      // in the other direction: Redis being down never *grants* anything.
      this.logger.error(
        `could not authorize ${channel}: ${(err as Error).message}`,
      );
      return 'realtime.channelForbidden';
    }
    if (refusal) return refusal;

    // Checked after authorization and only for a channel not already held, so
    // a client cannot fill its own budget by re-subscribing and an
    // unauthorized name never consumes a slot.
    if (
      !connection.subscriptions.has(channel) &&
      connection.subscriptions.size >= this.maxSubscriptions
    ) {
      return 'realtime.subscriptionLimit';
    }

    this.registry.subscribe(connection, channel);
    // The client is answered `subscribed` without waiting for the Redis
    // round trip this starts. An event published in that window is missed,
    // which the contract already allows — realtime delivery is at-most-once
    // and a durable answer, where one exists, is the producer's (D-15). What
    // holding the answer back would buy is nothing, and what it would cost is
    // a `subscribe` frame that blocks on Redis.
    void this.fanout.reconcile(channel);
    return null;
  }

  /**
   * Ping every connection; drop the ones that did not answer the last ping.
   *
   * This is not politeness. A TCP connection whose peer vanished — a laptop
   * closing, a phone changing network — stays open on this side indefinitely,
   * holding a socket, its subscriptions and its slot in the per-user cap. The
   * heartbeat is the only thing that ever notices.
   */
  private beat(): void {
    for (const connection of [...this.registry.all()]) {
      if (!connection.alive) {
        this.logger.debug(`connection ${connection.id} missed a heartbeat`);
        connection.socket.close(CloseCode.HeartbeatTimeout, 'heartbeat');
        // `close` is a handshake the dead peer will never answer, so the
        // registry entry is dropped now rather than waiting for a 'close'
        // event that may not arrive.
        this.drop(connection);
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  /**
   * Close every socket whose session has stopped being live.
   *
   * The gate answered "is this session live?" once, at the upgrade. An access
   * token lives ~15 minutes and a socket lives hours, so without this a user
   * who signed out — or an admin who revoked a session — keeps receiving
   * events on the connection that sign-out was supposed to end. Reading
   * `session:<id>` is the same question `forward-auth` asks per request and
   * the same rule applies to the answer: a missing marker means revoked, never
   * "unknown, allow" (`redis-keyspace/contract.md`).
   *
   * A Redis that is unreachable leaves connections open rather than closing
   * them all: a store outage is not evidence that every session was revoked,
   * and treating it as such would sign every user out at once. The next tick
   * asks again.
   */
  private async recheckSessions(): Promise<void> {
    // Anonymous connections have no session to re-check. They are not exempt
    // from anything — they hold no channel that a session could revoke, which
    // is why there is nothing to ask.
    const sessions = new Set(
      [...this.registry.all()]
        .filter((c) => c.identity)
        .map((c) => c.identity.sessionId),
    );
    if (sessions.size === 0) return;

    for (const sessionId of sessions) {
      let live: boolean;
      try {
        live = await this.redis.exists(RedisKeys.session(sessionId));
      } catch (err) {
        this.logger.error(
          `session re-check failed for ${sessionId}: ${(err as Error).message}`,
        );
        continue;
      }
      if (live) continue;

      for (const connection of this.registry.bySession(sessionId)) {
        this.logger.log(
          `closing ${connection.id}: session ${sessionId} is no longer live`,
        );
        connection.socket.close(CloseCode.SessionRevoked, 'session revoked');
        this.drop(connection);
      }
    }
  }

  /**
   * Forget one connection, and re-check every channel it was holding.
   *
   * The channels are read *before* the registry drops them, because after
   * that this replica has no record of what it may now be subscribed to for
   * nothing. Every path that removes a connection goes through here — a
   * closed socket, a missed heartbeat, a revoked session — since a path that
   * did not would leave a Redis subscription behind under a name the client
   * chose, which is a client-controlled leak.
   */
  private drop(connection: Connection): void {
    const channels = [...connection.subscriptions];
    this.registry.remove(connection.id);
    for (const channel of channels) void this.fanout.reconcile(channel);
  }

  onApplicationShutdown(): void {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.recheckTimer);
    for (const connection of [...this.registry.all()]) {
      connection.socket.close(CloseCode.GoingAway, 'shutting down');
    }
    this.wss.close();
  }
}

/**
 * Refuse an upgrade with a real HTTP response.
 *
 * A client that gets a 401 here knows to refresh its token and retry; one that
 * gets an opened-then-closed socket has to guess. The socket is destroyed
 * after the write because nothing else will ever be sent on it.
 */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}
