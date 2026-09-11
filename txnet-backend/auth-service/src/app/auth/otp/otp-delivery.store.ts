import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  encodeRealtimeFanout,
  otpRealtimeChannel,
  type OtpDeliveryEvent,
} from '@txnet-backend/shared-core';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';

/** Where one OTP send got to. `queued` is what a 202 leaves behind. */
export type OtpDeliveryState = 'queued' | 'sent' | 'failed';

/**
 * The three handles one OTP request mints, all at once, before anything is
 * decided about the account behind the phone number.
 *
 * They address two different things and it is worth keeping them apart:
 * `deliveryId` reads the status record, and `channelId` + `channelToken` hear
 * the result live. A client is given all three in the 202 and uses whichever
 * it can — the socket when it has one, the status route when it does not
 * (D-15).
 */
export interface OtpDeliveryHandles {
  deliveryId: string;
  /** The realtime channel is `otp:<channelId>` (`otpRealtimeChannel`). */
  channelId: string;
  /** The proof `gateway-service` demands before it will serve that channel. */
  channelToken: string;
}

export interface OtpDeliveryStatus {
  state: OtpDeliveryState;
  /** An i18n key, on `failed` only — the same keys the senders throw. */
  failureKey?: string;
}

/**
 * The delivery status a client reads after a 202 (F-067-a, D-15).
 *
 * D-15's answer is that the result is *pushed* to the user's socket; this is
 * the half that survives it. A client that reconnects, or never opened a
 * socket at all, reads the status once — so this store is not scaffolding for
 * F-067-j, it is the fallback F-067-j is built on top of.
 *
 * Redis rather than Postgres for the same reason the code itself is (ADR-0007):
 * it is state with a lifetime, and its lifetime is the code's.
 */
@Injectable()
export class OtpDeliveryStore {
  private readonly logger = new Logger(OtpDeliveryStore.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * A handle for one send, minted **per request** rather than per issued code.
   *
   * Every OTP route answers `{accepted:true}` whether or not a code was really
   * issued — that is what keeps them from being an account-existence oracle
   * (identity/contract.md). A delivery id handed out only when something was
   * sent would undo that in one field, so the id is minted before the decision
   * and the status for a request that issued nothing simply never moves off
   * `queued`, which is indistinguishable from a slow provider.
   */
  static newId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Mint the handles for one OTP request and store the channel's proof
   * (F-067-j).
   *
   * **Unconditional, and for exactly the reason `newId` is.** This runs before
   * the route knows whether there is an account to send anything to. A channel
   * that only worked for a real account would answer, through a subscription
   * that succeeds or is refused, the question `{accepted:true}` and the
   * `queued` status exist to refuse — and it would answer it on a socket,
   * where nobody is watching the rate limits.
   *
   * The token is stored in plain text. It is a 128-bit bearer capability with
   * a five-minute life whose entire authority is "hear the outcome of this one
   * send", and the value the reader compares against has to be the value the
   * client was handed — hashing it would mean the gateway hashing a client's
   * proof, which buys nothing against an attacker who can already read this
   * keyspace and costs a round of argon2 on every subscribe.
   */
  async mintHandles(): Promise<OtpDeliveryHandles> {
    const handles: OtpDeliveryHandles = {
      deliveryId: OtpDeliveryStore.newId(),
      channelId: OtpDeliveryStore.newId(),
      channelToken: OtpDeliveryStore.newId(),
    };
    await this.redis.set(
      RedisKeys.otpChannel(handles.channelId),
      handles.channelToken,
      RedisTtl.otpChannel,
    );
    return handles;
  }

  /**
   * Record where a send got to, and — for an end state — push it to whoever is
   * listening (F-067-j).
   *
   * **Both halves live here on purpose.** The record is the truth and the push
   * is a notification about it, so a caller that could do one without the
   * other is a caller that can leave a client waiting on a socket for an event
   * about a status that already changed. There are three call sites and they
   * are three branches of one method; keeping the pair together is what stops
   * a fourth from remembering only the write.
   *
   * `queued` is stored and not published: it is the state the 202 already told
   * the client about, and a client subscribing after it was published would
   * miss it anyway (`contract.fanout.md`).
   *
   * A failed publish is logged and swallowed. The code really was sent or
   * really was refused, the status says so, and a client that hears nothing
   * reads it — that fallback is D-15's whole point and it is why this is
   * allowed to be best-effort.
   */
  async mark(
    deliveryId: string,
    channelId: string,
    status: OtpDeliveryStatus,
  ): Promise<void> {
    await this.redis.setJson(
      RedisKeys.otpDelivery(deliveryId),
      status,
      RedisTtl.otpDelivery,
    );
    if (status.state === 'queued') return;

    const event: OtpDeliveryEvent = { state: status.state };
    if (status.failureKey) event.failureKey = status.failureKey;
    await this.publish(channelId, event);
  }

  /**
   * Fan the event out to the gateway replica holding the socket (F-067-i).
   *
   * The prefix is applied by hand because ioredis applies `keyPrefix` to keys
   * and Redis does not count a pub/sub channel as one — a publish that forgets
   * it succeeds into a channel nobody hears, with no error on either side
   * (`contract.fanout.md`). The channel name itself comes from `shared-core`,
   * so the three processes that have to agree on it cannot drift.
   */
  private async publish(channelId: string, event: OtpDeliveryEvent): Promise<void> {
    const wire =
      this.redis.keyPrefix +
      RedisKeys.realtimeFanout(otpRealtimeChannel(channelId));
    try {
      await this.redis.publish(wire, encodeRealtimeFanout(event));
    } catch (err) {
      this.logger.error(
        `could not push delivery ${event.state} on ${channelId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /** `null` once the TTL has passed, or for an id nobody ever minted. */
  read(deliveryId: string): Promise<OtpDeliveryStatus | null> {
    return this.redis.getJson<OtpDeliveryStatus>(
      RedisKeys.otpDelivery(deliveryId),
    );
  }
}
