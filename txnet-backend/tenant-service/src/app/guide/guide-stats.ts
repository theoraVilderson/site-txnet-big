import { Injectable, Logger } from '@nestjs/common';
import { GuideViewSurface } from '@prisma/client';
import { RedisTtl, UnscopedRedisKeys, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';
import { createHash } from 'node:crypto';

import { PlatformTenant } from '../files/platform-tenant';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GuideActor, GuideRefused } from './guide-admin';
import { GuideReader } from './guide-reader';

/**
 * F-414-l — **guide views and votes** (ADR-0119).
 *
 * Counted per **reading** tenant (the Host's or the bot's) against the id of
 * the guide row it showed, which may be the platform's: a reseller's override
 * shares the platform guide's key, and its numbers are about another text.
 *
 * A view is one viewer, one guide, one UTC day, one surface — a Redis marker
 * makes the second report a no-op, and Redis down counts nothing rather than
 * twice. A vote is one per known user per guide and can be changed; the guide
 * must be one the user's tenant sees now. A reseller reads its own numbers;
 * the platform owner every tenant's for the platform's guides.
 */

export type ViewOutcome = 'counted' | 'seen' | 'unknown' | 'skipped';

export interface GuideStat {
  guideId: string;
  views: number;
  panelViews: number;
  botViews: number;
  helpful: number;
  notHelpful: number;
}

/** The periods the numbers are read over, as the query spells them; 30 when left out. */
export const GUIDE_STATS_DAYS = ['7', '30', '90'] as const;

/** A viewer as a short hash — the marker key never holds an IP or a chat id. */
export function viewerHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('base64url').slice(0, 22);
}

const utcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

type ViewSum = { guideId: string; surface: GuideViewSurface; _sum: { views: number | null } };
type VoteCount = { guideId: string; helpful: boolean; _count: { _all: number } };

/** One line per guide, in the order a guide first appears (views, then votes). */
export function statsOf(views: ViewSum[], votes: VoteCount[]): GuideStat[] {
  const out = new Map<string, GuideStat>();
  const line = (guideId: string) => {
    let s = out.get(guideId);
    if (!s) out.set(guideId, (s = { guideId, views: 0, panelViews: 0, botViews: 0, helpful: 0, notHelpful: 0 }));
    return s;
  };
  for (const v of views) {
    const s = line(v.guideId);
    const n = v._sum.views ?? 0;
    s.views += n;
    if (v.surface === GuideViewSurface.panel) s.panelViews += n;
    else s.botViews += n;
  }
  for (const v of votes) {
    const s = line(v.guideId);
    if (v.helpful) s.helpful += v._count._all;
    else s.notHelpful += v._count._all;
  }
  return [...out.values()];
}

@Injectable()
export class GuideStats {
  private readonly logger = new Logger(GuideStats.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
    private readonly reader: GuideReader,
    private readonly platform: PlatformTenant,
  ) {}

  /** One view of `key` as `tenantId` shows it; the caller has that tenant in scope. */
  async view(tenantId: string, key: string, surface: GuideViewSurface, viewer: string, lang: string, at = new Date()): Promise<ViewOutcome> {
    const guide = (await this.reader.one(tenantId, key, lang)).body.guide;
    if (!guide?.id) return 'unknown';
    const day = utcDay(at);
    let first: boolean;
    try {
      first = await this.redis.setIfAbsentWithTtl(
        UnscopedRedisKeys.guideViewSeen(tenantId, guide.id, day.toISOString().slice(0, 10), surface, viewer),
        '1',
        RedisTtl.guideViewSeen,
      );
    } catch (err) {
      this.logger.warn(`guide view not counted, redis unreadable: ${(err as Error).message}`);
      return 'skipped';
    }
    if (!first) return 'seen';
    await tenantTransaction(this.prisma, (tx) =>
      tx.guideViewDaily.upsert({
        where: { tenantId_guideId_day_surface: { tenantId, guideId: guide.id, day, surface } },
        create: { tenantId, guideId: guide.id, day, surface, views: 1 },
        update: { views: { increment: 1 } },
      }),
    );
    return 'counted';
  }

  /** A known user's vote on a guide their tenant sees; `guide_unknown` otherwise. */
  async vote(tenantId: string, userId: string, key: string, helpful: boolean, lang: string): Promise<{ helpful: boolean }> {
    const guideId = await this.seen(tenantId, key, lang);
    const row = await tenantTransaction(this.prisma, (tx) =>
      tx.guideVote.upsert({
        where: { tenantId_guideId_userId: { tenantId, guideId, userId } },
        create: { tenantId, guideId, userId, helpful },
        update: { helpful },
        select: { helpful: true },
      }),
    );
    return { helpful: row.helpful };
  }

  /** The user's own vote on the guide their tenant shows under `key`, `null` for none. */
  async myVote(tenantId: string, userId: string, key: string, lang: string): Promise<{ helpful: boolean | null }> {
    const guideId = await this.seen(tenantId, key, lang);
    const row = await tenantTransaction(this.prisma, (tx) =>
      tx.guideVote.findUnique({ where: { tenantId_guideId_userId: { tenantId, guideId, userId } }, select: { helpful: true } }),
    );
    return { helpful: row?.helpful ?? null };
  }

  /**
   * The last `days` days of views (today included) and every current vote. A
   * reseller: its own tenant's rows. The platform owner: every tenant's, for
   * the platform's guides only.
   */
  async stats(actor: GuideActor, days: number, now = new Date()): Promise<{ days: number; since: string; stats: GuideStat[] }> {
    const since = utcDay(new Date(now.getTime() - (days - 1) * 86_400_000));
    const isPlatform = actor.tenantId === (await this.platform.id());
    const scope = isPlatform ? { guide: { tenantId: null } } : { tenantId: actor.tenantId };
    const read = async (tx: Pick<PrismaService, 'guideViewDaily' | 'guideVote'>) => {
      const [views, votes] = await Promise.all([
        tx.guideViewDaily.groupBy({ by: ['guideId', 'surface'], where: { ...scope, day: { gte: since } }, _sum: { views: true } }),
        tx.guideVote.groupBy({ by: ['guideId', 'helpful'], where: scope, _count: { _all: true } }),
      ]);
      return statsOf(views as ViewSum[], votes as VoteCount[]);
    };
    const stats = isPlatform
      ? await this.all.$transaction((tx) => read(tx))
      : await runWithTenant({ id: actor.tenantId }, () => tenantTransaction(this.prisma, (tx) => read(tx)));
    return { days, since: since.toISOString().slice(0, 10), stats };
  }

  private async seen(tenantId: string, key: string, lang: string): Promise<string> {
    const guide = (await this.reader.one(tenantId, key, lang)).body.guide;
    if (!guide?.id) throw new GuideRefused('guide_unknown', key);
    return guide.id;
  }
}
