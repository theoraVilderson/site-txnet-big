import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityHeaders, RedisTtl, RequestHeaders, UnscopedRedisKeys } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { RedisService } from '../redis/redis.service';

/**
 * New-message notices (F-033-i): when a thread has something for a reader who
 * is not looking at it, one row in their panel inbox — which also reaches an
 * open panel over the socket (notification `contract.md`).
 *
 * - an agent's reply or resolve tells the conversation's user;
 * - a user's message tells the assignee — no one while it is unassigned: the
 *   queue is how a free agent finds it (user, 2026-10-03).
 *
 * **One per conversation until read.** The reader's cursor at the moment of
 * the notice is remembered; the next one goes out only once they have read
 * past it. The words are auth-service's templates, in the reader's language
 * (`internal/notify/user`, ADR-0045 decision 2).
 *
 * **Best effort, after the commit.** The message is the record and the thread
 * reads without any notice; a refused seam is logged, never thrown, and not
 * remembered — the next message tries again.
 *
 * **The user's chats too (F-309).** A reply or a resolve also goes to the
 * user's Telegram/Bale chats, carrying the conversation id so its button opens
 * the thread there. The inbox row is the record: a chat that cannot be told is
 * logged and does not undo it. An agent's notice stays in the inbox — agents
 * answer from the panel.
 */

export const SUPPORT_NOTICES = ['supportReplied', 'supportResolved', 'supportUserWrote'] as const;
export type SupportNotice = (typeof SUPPORT_NOTICES)[number];

/** Who to tell about which conversation, and how far they have read it. */
export interface NoticeTarget {
  conversationId: string;
  userId: string;
  readUpTo: number;
  subject: string;
}

/** What auth-service's seam takes (`user-notify-internal.controller.ts`). */
export interface NoticeBody {
  userId: string;
  channel: 'inbox' | 'bot';
  template: SupportNotice;
  params: { subject: string; conversationId?: string };
}

/** The notices told in the user's chats as well (F-309). */
const TOLD_IN_CHAT: ReadonlySet<SupportNotice> = new Set(['supportReplied', 'supportResolved']);

/** The Redis calls this needs — the seam the spec fakes. */
export interface NoticeRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

export interface NoticeSeam {
  notify(tenantId: string, body: NoticeBody): Promise<void>;
}

export const SUPPORT_NOTICE_SEAM = Symbol('SUPPORT_NOTICE_SEAM');

/** The seam's cap on one param (`params: z.record(z.string().max(200))`). */
const PARAM_MAX = 200;

@Injectable()
export class SupportNotifier {
  private readonly logger = new Logger(SupportNotifier.name);

  constructor(
    @Inject(RedisService) private readonly redis: NoticeRedis,
    @Inject(SUPPORT_NOTICE_SEAM) private readonly seam: NoticeSeam,
  ) {}

  /** Whether a notice went out. Never throws. */
  async tell(tenantId: string, template: SupportNotice, target: NoticeTarget): Promise<boolean> {
    const key = UnscopedRedisKeys.supportNotified(target.conversationId, target.userId);
    try {
      const toldAt = await this.redis.get(key);
      if (toldAt !== null && Number(toldAt) >= target.readUpTo) return false;
      const subject = target.subject.slice(0, PARAM_MAX);
      await this.seam.notify(tenantId, { userId: target.userId, channel: 'inbox', template, params: { subject } });
      await this.redis.set(key, String(target.readUpTo), RedisTtl.supportNotified);
      if (TOLD_IN_CHAT.has(template)) {
        await this.seam
          .notify(tenantId, { userId: target.userId, channel: 'bot', template, params: { subject, conversationId: target.conversationId } })
          .catch((e: unknown) => this.logger.warn(`${template} for conversation ${target.conversationId} not told in chat: ${(e as Error).message}`));
      }
      return true;
    } catch (e) {
      this.logger.warn(`${template} for conversation ${target.conversationId} not told: ${(e as Error).message}`);
      return false;
    }
  }
}

/** auth-service's `POST /api/internal/notify/user`, with `SERVICE_AUTH_TOKEN`. */
@Injectable()
export class HttpNoticeSeam implements NoticeSeam {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.baseUrl = config.get('AUTH_API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.serviceToken = config.get('SERVICE_AUTH_TOKEN', { infer: true });
    this.timeoutMs = config.get('AUTH_API_TIMEOUT_MS', { infer: true });
  }

  async notify(tenantId: string, body: NoticeBody): Promise<void> {
    if (!this.baseUrl || !this.serviceToken) throw new Error('AUTH_API_BASE_URL or SERVICE_AUTH_TOKEN is not set');
    const response = await fetch(`${this.baseUrl}/api/internal/notify/user`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [RequestHeaders.serviceToken]: this.serviceToken,
        [IdentityHeaders.tenantId]: tenantId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`auth-api answered ${response.status}`);
  }
}
