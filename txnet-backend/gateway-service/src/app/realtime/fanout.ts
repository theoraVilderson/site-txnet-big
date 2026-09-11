import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  decodeRealtimeFanout,
  REALTIME_FANOUT_PREFIX,
} from '@txnet-backend/shared-core';
import {
  RedisService,
  type FanoutSubscriberClient,
} from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';
import { ConnectionRegistry } from './connection.registry';

/** What this class needs of `RedisService`, and nothing more. */
export interface FanoutRedis {
  readonly keyPrefix: string;
  readonly subscriber: FanoutSubscriberClient;
}

/**
 * The consumer half of the fan-out (F-067-i): events computed somewhere else
 * arriving at the replica that holds the user's socket.
 *
 * **The failure this exists to remove.** `ConnectionRegistry` is per process.
 * A worker that finishes a job is a different process, usually on a different
 * machine, so before this row `deliver` reached only the sockets that happened
 * to be on the same replica. With one replica that is every socket and
 * everything works; with two it is half of them, no error is raised on either
 * side, and the symptom is a feature that works in dev and silently does not
 * in production.
 *
 * **This replica subscribes to exactly the channels its own connections
 * hold.** Redis then routes each event to the replicas that can use it, which
 * is what makes the fan-out cost the same whether there are two replicas or
 * twenty. The subscription set is kept in step with the registry by
 * {@link reconcile}, called after every subscribe, unsubscribe and dropped
 * connection.
 *
 * **It re-decides nothing about who may hear what.** A connection is on a
 * channel because `channel.ts` authorized it there; this class routes by name
 * and never inspects an identity. That keeps the unit's one invariant — a
 * connection hears its own channels and no others — in a single place, which
 * is the only way it stays true as families are added.
 */
@Injectable()
export class RealtimeFanout {
  private readonly logger = new Logger(RealtimeFanout.name);

  /** Wire channel names this replica currently holds a subscription for. */
  private readonly subscribed = new Set<string>();
  /** In-flight reconciliations, one chain per channel — see {@link reconcile}. */
  private readonly settling = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: ConnectionRegistry,
    @Inject(RedisService) private readonly redis: FanoutRedis,
  ) {}

  /**
   * Start hearing messages. Called once, from the gateway's `attach`.
   *
   * Separate from the constructor so the handler is attached at the moment the
   * process starts accepting sockets, next to the timers that keep them — the
   * three things that make this replica live, started in one place.
   */
  listen(): void {
    this.redis.subscriber.on('message', (wire, raw) => this.receive(wire, raw));
  }

  /**
   * Make this replica's subscriptions match what the registry actually holds
   * for `channel`.
   *
   * Reconciling against the registry rather than acting on the caller's word
   * is what makes this safe to call from anywhere. A subscribe and an
   * unsubscribe on one channel can race — two tabs, one closing as the other
   * opens — and a pair of "do the opposite of what just happened" commands
   * settles on whichever round trip finished last, which is the wrong answer
   * half the time and leaves either a dead subscription or a silent channel.
   * Reading the desired state at the moment the command is issued cannot.
   *
   * The chain per channel is the other half: two concurrent reconciles of one
   * channel would otherwise both read "not subscribed" and both subscribe.
   */
  reconcile(channel: string): Promise<void> {
    const previous = this.settling.get(channel) ?? Promise.resolve();
    const next = previous.then(() => this.settle(channel));
    this.settling.set(channel, next);
    void next.then(() => {
      // Only the tail clears the entry; an earlier link finishing must not
      // drop a chain that still has work queued behind it.
      if (this.settling.get(channel) === next) this.settling.delete(channel);
    });
    return next;
  }

  private async settle(channel: string): Promise<void> {
    const wire = this.wireName(channel);
    const wanted = this.registry.hasChannel(channel);
    if (wanted === this.subscribed.has(wire)) return;

    try {
      if (wanted) {
        await this.redis.subscriber.subscribe(wire);
        this.subscribed.add(wire);
      } else {
        await this.redis.subscriber.unsubscribe(wire);
        this.subscribed.delete(wire);
      }
    } catch (err) {
      // Never rethrown: the caller is a frame handler or a socket close, and
      // neither has anywhere to put this. A subscribe that failed means this
      // channel is silent on this replica until the next connection joins it;
      // that is a degraded socket, not a broken process, and the alternative
      // — a rejection nobody awaits — is an unhandled rejection that takes
      // every other socket with it.
      this.logger.error(
        `could not ${wanted ? 'subscribe to' : 'unsubscribe from'} ${wire}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * One event off the bus.
   *
   * Nothing here throws. A pub/sub listener has no caller to catch it, so an
   * exception raised on a body somebody else published would take the process
   * — and every socket on it — down.
   */
  private receive(wire: string, raw: string): void {
    const channel = this.channelOf(wire);
    if (!channel) {
      // Not ours: a different keyspace version, or another service sharing the
      // Redis. Ignored rather than logged per message, because a busy
      // neighbour would otherwise write this line thousands of times a second.
      return;
    }

    const message = decodeRealtimeFanout(raw);
    if (!message) {
      this.logger.warn(`dropping a body on ${wire} that is not a fan-out event`);
      return;
    }

    this.registry.deliver(channel, message.payload);
  }

  /** `user:u1` -> `txnet:auth:v2:realtime:user:u1`. */
  private wireName(channel: string): string {
    return `${this.redis.keyPrefix}${RedisKeys.realtimeFanout(channel)}`;
  }

  /** The inverse, or `null` for a name this replica did not ask for. */
  private channelOf(wire: string): string | null {
    const prefix = `${this.redis.keyPrefix}${REALTIME_FANOUT_PREFIX}`;
    return wire.startsWith(prefix) ? wire.slice(prefix.length) : null;
  }
}
