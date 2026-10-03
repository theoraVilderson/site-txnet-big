import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RedisTtl,
  SupportRealtimeEvent,
  encodeRealtimeFanout,
  supportRealtimeChannel,
} from '@txnet-backend/shared-core';

import type { MessageView, SupportCaller } from '../conversations/conversations.service';
import { RedisKeys } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';

/**
 * Live conversations (F-034): the proof a reader subscribes to
 * `support:<conversationId>` with, and the events published on it.
 *
 * Who may hear a thread is decided here, by whoever calls `channelProof` —
 * only after the reader was shown to own the thread (or, with F-033-d, to be an
 * agent of its tenant). The gateway compares the proof and knows nothing else
 * (`realtime/contract.channels.md`).
 *
 * Every event is at-most-once and only a notice: the stored conversation is
 * the record, and a client that missed one reads `?afterSeq=` (ADR-0112).
 * **An internal note is never published here**: the user reads this channel.
 */

/** How long a "typing" lasts unless repeated. The client re-sends every few seconds while typing. */
export const TYPING_TTL_MS = 6000;

/** The Redis calls this needs — the seam the spec fakes. */
export interface SupportRealtimeRedis {
  readonly keyPrefix: string;
  setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  expire(key: string, ttlSec: number): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
}

export interface ChannelProof {
  channel: string;
  proof: string;
  /** Subscribe before this lapses; a read of the thread refreshes it. */
  expiresInSec: number;
}

@Injectable()
export class SupportRealtime {
  private readonly logger = new Logger(SupportRealtime.name);

  constructor(@Inject(RedisService) private readonly redis: SupportRealtimeRedis) {}

  /**
   * The reader's proof for this conversation: one per reader and thread, kept
   * while it is in use, so a second tab or a reconnect presents the same one.
   * `null` when Redis cannot answer — the thread still reads, it is just not live.
   */
  async channelProof(caller: SupportCaller, conversationId: string): Promise<ChannelProof | null> {
    const key = RedisKeys.supportChannel(conversationId, caller.userId);
    const ttl = RedisTtl.supportChannel;
    try {
      const minted = randomBytes(32).toString('hex');
      if (await this.redis.setNx(key, minted, ttl)) {
        return { channel: supportRealtimeChannel(conversationId), proof: minted, expiresInSec: ttl };
      }
      const proof = await this.redis.get(key);
      if (!proof) return null;
      await this.redis.expire(key, ttl);
      return { channel: supportRealtimeChannel(conversationId), proof, expiresInSec: ttl };
    } catch (e) {
      this.logger.warn(`support channel proof unavailable: ${(e as Error).message}`);
      return null;
    }
  }

  /** A message every reader of the thread may see — never an internal note. */
  message(conversationId: string, view: MessageView, status: string): Promise<void> {
    const { mine: _mine, ...message } = view;
    return this.publish(conversationId, {
      kind: 'support.message',
      conversationId,
      status,
      message: { ...message, createdAt: view.createdAt.toISOString() },
    });
  }

  read(conversationId: string, readerKind: string, lastReadSeq: number): Promise<void> {
    return this.publish(conversationId, { kind: 'support.read', conversationId, readerKind, lastReadSeq });
  }

  typing(conversationId: string, senderKind: string): Promise<void> {
    return this.publish(conversationId, { kind: 'support.typing', conversationId, senderKind, expiresInMs: TYPING_TTL_MS });
  }

  /** An agent resolved or closed the thread (F-033-d): the user's panel shows it without a re-read. */
  status(conversationId: string, status: string): Promise<void> {
    return this.publish(conversationId, { kind: 'support.status', conversationId, status });
  }

  /** Logged and swallowed: the write it announces already happened. */
  private async publish(conversationId: string, event: SupportRealtimeEvent): Promise<void> {
    const wire = `${this.redis.keyPrefix}${RedisKeys.realtimeFanout(supportRealtimeChannel(conversationId))}`;
    try {
      await this.redis.publish(wire, encodeRealtimeFanout(event));
    } catch (e) {
      this.logger.error(`could not publish ${event.kind} on support:${conversationId}: ${(e as Error).message}`);
    }
  }
}
