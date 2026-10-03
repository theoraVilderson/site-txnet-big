import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConversationMode, Prisma } from '@prisma/client';
import { PLATFORM_DEFAULT_TIMEZONE, RedisTtl, canonicalTimeZone, tenantTransaction } from '@txnet-backend/shared-core';

import { ConversationRefused, SupportCaller } from '../conversations/refusal';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';
import { HoursInterval, WorkingHours, nextOpening, withinHours } from './working-hours';

/**
 * Whether a human is answering right now (F-033-g, catalog §11.2, user
 * 2026-10-03): **live** while at least one agent is online and the tenant is
 * inside its weekly working hours, **async** otherwise — with the moment it
 * next opens, for the user's wait notice.
 *
 * Presence is a heartbeat, not a session: an agent's panel beats every 30s and
 * is forgotten {@link RedisTtl.supportPresence} seconds after the last one, so
 * a closed laptop goes offline on its own. It lives in Redis only; when Redis
 * cannot answer, nobody is online and every thread is async — a wrong `live`
 * promises a reply that is not coming, a wrong `async` only under-promises.
 */

export const PRESENCE_STATUSES = ['online', 'away'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export interface Availability {
  /** A conversation opened now opens `live`. */
  live: boolean;
  withinHours: boolean;
  agentsOnline: boolean;
  /** When support next opens; `null` while open, or with no schedule. */
  nextOpenAt: Date | null;
}

/** The sorted-set calls presence needs — the seam the spec fakes. */
export interface PresenceRedis {
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  /** Members scored above `min`. */
  zrangebyscore(key: string, min: number): Promise<string[]>;
  /** Drops members scored at or below `max`. */
  zremrangebyscore(key: string, max: number): Promise<void>;
  expire(key: string, ttlSec: number): Promise<void>;
}

/** How the settings route takes an interval: local `HH:MM`, `24:00` allowed as an end. */
export interface HoursInput {
  weekday: number;
  start: string;
  end: string;
}

/** At most a handful of shifts a day; a longer list is a client bug, not a schedule. */
export const HOURS_MAX_INTERVALS = 28;

@Injectable()
export class SupportAvailability {
  private readonly logger = new Logger(SupportAvailability.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: PresenceRedis,
  ) {}

  /** An agent's heartbeat (`online`) or sign-off (`away`). */
  async beat(caller: SupportCaller, status: PresenceStatus, now = new Date()): Promise<{ status: PresenceStatus; expiresInSec: number }> {
    const key = RedisKeys.supportPresence(caller.tenantId);
    const ttl = RedisTtl.supportPresence;
    if (status === 'away') {
      await this.redis.zrem(key, caller.userId);
      return { status, expiresInSec: 0 };
    }
    await this.redis.zadd(key, now.getTime() + ttl * 1000, caller.userId);
    await this.redis.expire(key, ttl);
    return { status, expiresInSec: ttl };
  }

  /** The tenant's agents whose heartbeat has not lapsed; none when Redis cannot say. */
  async online(tenantId: string, now = new Date()): Promise<string[]> {
    const key = RedisKeys.supportPresence(tenantId);
    try {
      await this.redis.zremrangebyscore(key, now.getTime());
      return await this.redis.zrangebyscore(key, now.getTime());
    } catch (e) {
      this.logger.warn(`support presence unreadable, answering async: ${(e as Error).message}`);
      return [];
    }
  }

  /** The tenant's schedule on its own wall clock. */
  async hours(tenantId: string): Promise<WorkingHours> {
    return tenantTransaction(this.prisma, (tx) => readHours(tx, tenantId));
  }

  /** Replaces the whole schedule; an empty list means always open. */
  async setHours(tenantId: string, input: HoursInput[]): Promise<WorkingHours> {
    const intervals = intervalsFrom(input);
    await tenantTransaction(this.prisma, async (tx) => {
      await tx.supportWorkingHours.deleteMany({ where: { tenantId } });
      if (intervals.length > 0) await tx.supportWorkingHours.createMany({ data: intervals.map((i) => ({ tenantId, ...i })) });
    });
    return this.hours(tenantId);
  }

  async at(tenantId: string, now = new Date()): Promise<Availability> {
    const [hours, online] = await Promise.all([this.hours(tenantId), this.online(tenantId, now)]);
    const within = withinHours(hours, now);
    return {
      live: within && online.length > 0,
      withinHours: within,
      agentsOnline: online.length > 0,
      nextOpenAt: nextOpening(hours, now),
    };
  }

  /** The mode a conversation takes when it is opened or written to now. */
  async mode(tenantId: string, now = new Date()): Promise<ConversationMode> {
    return (await this.at(tenantId, now)).live ? ConversationMode.live : ConversationMode.async;
  }
}

/** A tenant's schedule inside a caller's transaction — the SLA clock reads it with the write it times (F-033-h). */
export async function readHours(tx: Prisma.TransactionClient, tenantId: string): Promise<WorkingHours> {
  const [tenant, rows] = await Promise.all([
    tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    tx.supportWorkingHours.findMany({ where: { tenantId }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] }),
  ]);
  return {
    // ADR-0108 rule 2: a zone the runtime cannot read is skipped, never thrown.
    zone: canonicalTimeZone(tenant?.timezone) ?? PLATFORM_DEFAULT_TIMEZONE,
    intervals: rows.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
  };
}

/**
 * Local `HH:MM` pairs to minute intervals: `start < end`, `end` up to `24:00`,
 * and no two intervals of one weekday overlap — refused as `hours_invalid`.
 */
export function intervalsFrom(input: HoursInput[]): HoursInterval[] {
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const intervals = input
    .map((i) => ({ weekday: i.weekday, startMinute: minutes(i.start), endMinute: minutes(i.end) }))
    .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  intervals.forEach((i, n) => {
    if (i.startMinute >= i.endMinute || i.endMinute > 1440) throw new ConversationRefused('hours_invalid');
    const prev = intervals[n - 1];
    if (prev && prev.weekday === i.weekday && i.startMinute < prev.endMinute) throw new ConversationRefused('hours_invalid');
  });
  return intervals;
}
