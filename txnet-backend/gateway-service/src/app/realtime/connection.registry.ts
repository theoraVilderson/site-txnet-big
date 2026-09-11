import { Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { ConnectionIdentity } from './channel';
import type { ServerFrame } from './protocol';

/**
 * One live socket.
 *
 * `subscriptions` is a `Set` and not an array because the cap is counted from
 * its size: subscribing twice to one channel must not spend two of the
 * budget, or a client empties its own allowance by retrying.
 */
export interface Connection {
  readonly id: string;
  /**
   * What the gate proved, or `null` for an anonymous connection (ADR-0031).
   * Every read of it has to cope with the null — a connection with no identity
   * is ordinary here, not an error state.
   */
  readonly identity: ConnectionIdentity | null;
  /** The client address, indexed for the anonymous cap. */
  readonly address: string;
  readonly socket: WebSocket;
  readonly subscriptions: Set<string>;
  /** Set false when a heartbeat ping goes out, true again on the pong. */
  alive: boolean;
}

/**
 * Every connection this replica holds, indexed the two ways it is asked
 * about: by connection id, and by the channels a connection listens to.
 *
 * **This is per replica**, and `deliver` reaches only the connections that
 * happen to be on *this* gateway. That was the gap F-067-i was opened for; it
 * is closed above this class rather than inside it. `RealtimeFanout`
 * subscribes this replica to exactly the channels the index holds and calls
 * `deliver` when one carries an event, so the registry stayed a process-local
 * lookup and gained only the question the fan-out reconciles against
 * ({@link ConnectionRegistry.hasChannel}).
 */
@Injectable()
export class ConnectionRegistry {
  private readonly logger = new Logger(ConnectionRegistry.name);
  private readonly byId = new Map<string, Connection>();
  private readonly byUser = new Map<string, Set<string>>();
  /**
   * Anonymous connections only. A signed-in caller is capped by user, which is
   * the better key wherever it exists — it survives a phone changing network
   * and it does not lump an office behind one NAT into a single budget. An
   * anonymous caller has no such key, so this is the only one left.
   */
  private readonly byAddress = new Map<string, Set<string>>();
  private readonly byChannel = new Map<string, Set<string>>();

  add(connection: Connection): void {
    this.byId.set(connection.id, connection);
    if (connection.identity) {
      index(this.byUser, connection.identity.userId, connection.id);
    } else {
      index(this.byAddress, connection.address, connection.id);
    }
  }

  remove(connectionId: string): void {
    const connection = this.byId.get(connectionId);
    if (!connection) return;

    for (const channel of connection.subscriptions) {
      deindex(this.byChannel, channel, connectionId);
    }
    if (connection.identity) {
      deindex(this.byUser, connection.identity.userId, connectionId);
    } else {
      deindex(this.byAddress, connection.address, connectionId);
    }
    this.byId.delete(connectionId);
  }

  subscribe(connection: Connection, channel: string): void {
    connection.subscriptions.add(channel);
    index(this.byChannel, channel, connection.id);
  }

  unsubscribe(connection: Connection, channel: string): void {
    connection.subscriptions.delete(channel);
    deindex(this.byChannel, channel, connection.id);
  }

  /** How many sockets this user already holds here. Feeds the per-user cap. */
  countForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  /**
   * How many **anonymous** sockets this address already holds here. Feeds the
   * cap that replaces the per-user one when there is no user.
   *
   * It counts only anonymous connections on purpose: a signed-in caller is
   * already bounded by `countForUser`, and counting it twice would mean a
   * shared address could exhaust an allowance that the per-user cap has
   * already limited more precisely.
   */
  countForAddress(address: string): number {
    return this.byAddress.get(address)?.size ?? 0;
  }

  /**
   * Does any connection on this replica hold `channel`?
   *
   * The question the fan-out reconciles against (F-067-i): this replica is
   * subscribed to a channel exactly while the answer is yes. It reads the
   * channel index rather than counting, because `deindex` already deletes an
   * emptied entry — so "the key exists" and "somebody is listening" are the
   * same fact and cannot disagree.
   */
  hasChannel(channel: string): boolean {
    return this.byChannel.has(channel);
  }

  all(): Iterable<Connection> {
    return this.byId.values();
  }

  /**
   * Send one frame to every connection subscribed to `channel` **on this
   * replica**. What `RealtimeFanout` calls with an event off the bus.
   */
  deliver(channel: string, payload: unknown): number {
    const ids = this.byChannel.get(channel);
    if (!ids) return 0;

    let delivered = 0;
    for (const id of ids) {
      const connection = this.byId.get(id);
      if (connection && send(connection, { type: 'message', channel, payload })) {
        delivered += 1;
      }
    }
    return delivered;
  }

  /** Every connection whose session is `sessionId` — used when one is revoked. */
  bySession(sessionId: string): Connection[] {
    return [...this.byId.values()].filter(
      (c) => c.identity && c.identity.sessionId === sessionId,
    );
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * Write one frame. Returns whether it went out.
 *
 * A socket that has started closing still accepts `send` and throws
 * asynchronously, which on a raw `ws` connection is an unhandled error event —
 * so the state is checked and the write is guarded. One client's dead socket
 * must never be able to take the process down with every other client's.
 */
export function send(connection: Connection, frame: ServerFrame): boolean {
  // 1 === WebSocket.OPEN. Compared numerically so this module needs no value
  // import from `ws`, which keeps it usable from a unit test with a fake.
  if (connection.socket.readyState !== 1) return false;
  try {
    connection.socket.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function index(map: Map<string, Set<string>>, key: string, id: string): void {
  const existing = map.get(key);
  if (existing) existing.add(id);
  else map.set(key, new Set([id]));
}

function deindex(map: Map<string, Set<string>>, key: string, id: string): void {
  const existing = map.get(key);
  if (!existing) return;
  existing.delete(id);
  // Delete the empty set rather than leaving it: a channel name is
  // client-chosen, so a map that only ever grows is a client-controlled leak.
  if (existing.size === 0) map.delete(key);
}
