import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  UnscopedRedisKeys,
  operatingCurrencyOf,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { Granularity } from './analytics-buckets';
import { TabContext, contextOf } from './analytics-context';
import { catalogOf } from './analytics-catalog';
import { overviewOf } from './analytics-overview';
import { salesOf } from './analytics-sales';
import { AnalyticsQuery, AnalyticsTab } from './analytics.schema';

export class AnalyticsRefused extends Error {
  constructor(
    readonly reason: ResellerAccessRejection,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'AnalyticsRefused';
  }
}

/** How long an answer stays cached. A changed pass bumps the version first, so this bounds memory, not staleness. */
const ANSWER_TTL_SEC = 3600;

/** Three years compared with three more is a few dozen grouped reads; the default 5 s is one day's budget. */
const READ_TIMEOUT_MS = 30_000;

/**
 * What every tab answers around its own figures (billing/contract.analytics.md
 * "Read routes"): the query as resolved — its defaults filled — under its own
 * key, so no figure a tab names (`calendar`, the heatmap) can shadow it.
 */
type Head = { tab: AnalyticsTab; query: AnalyticsQuery; refreshedAt: string | null };

/** While a whole rebuild runs the figures are half-built, so none are answered (principle 5). */
export type AnalyticsAnswer = (Head & { rebuilding: true }) | (Head & { rebuilding: false; granularity: Granularity; buckets: string[]; suppressed: boolean } & Record<string, unknown>);

/** Each tab's builder; a tab with no row yet has none. */
const TABS: Record<AnalyticsTab, (c: TabContext) => Promise<object>> = { overview: overviewOf, sales: salesOf, catalog: catalogOf };

/**
 * The analytics tabs (F-1001-b): `overview`, `sales`, `catalog` for the tenant
 * the **path** names, read from the rollup only (principle 1). The door is
 * `ResellerAccess` with `analytics.read` — the owner, a member holding the
 * key, or the platform's staff with `platform.report.read`, who see a reseller
 * at tier A (cells under 5 people hidden, ADR-0104). An answer is cached per
 * rollup version; `refreshedAt` is read fresh every time, so "updated N min
 * ago" never comes from the cache.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly redis: RedisService,
  ) {}

  read(actor: ResellerActor, tenantId: string, tab: AnalyticsTab, q: AnalyticsQuery): Promise<AnalyticsAnswer> {
    return this.run(actor, tenantId, async (admitted) => {
      const state = await tenantTransaction(this.prisma, (tx) => tx.analyticsRollupState.findUnique({ where: { tenantId } }));
      const head: Head = { tab, query: q, refreshedAt: state?.refreshedAt?.toISOString() ?? null };
      if (!state || state.rebuildingSince) return { ...head, rebuilding: true };

      const hides = admitted.as === 'staff' && admitted.platform !== true;
      const key = UnscopedRedisKeys.analyticsAnswer(tenantId, state.version, tab, createHash('sha256').update(JSON.stringify({ q, hides })).digest('hex'));
      const cached = await this.cached(key);
      if (cached) return { ...head, rebuilding: false, ...cached };

      // Redis stays outside the transaction (C-29). A pass committing between
      // the two reads caches newer figures under the older version, which the
      // bump has already retired — never older figures under the newer one.
      const body = await tenantTransaction(
        this.prisma,
        async (tx) => {
          const c = contextOf(tx, q, { operating: await operatingCurrencyOf(tx, tenantId), hides });
          return { granularity: c.granularity, buckets: c.buckets, suppressed: hides, ...(await TABS[tab](c)) };
        },
        { timeout: READ_TIMEOUT_MS },
      );
      await this.cache(key, body);
      return { ...head, rebuilding: false, ...body };
    });
  }

  /** A cache read that fails is a miss, never a failed page: the rollup answers instead. */
  private async cached(key: string): Promise<{ granularity: Granularity; buckets: string[]; suppressed: boolean } | null> {
    try {
      const hit = await this.redis.get(key);
      return hit ? JSON.parse(hit) : null;
    } catch (e) {
      this.logger.warn(`analytics cache read failed, answering from the rollup: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async cache(key: string, body: object): Promise<void> {
    try {
      await this.redis.setWithTtl(key, JSON.stringify(body), ANSWER_TTL_SEC);
    } catch (e) {
      this.logger.warn(`analytics cache write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Admit, run in the tenant's scope, and translate the door's refusal into this surface's one type. */
  private async run<T>(actor: ResellerActor, tenantId: string, work: (admitted: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      // The platform's own tenant too, to its staff — its own analytics (principle 4).
      return await this.access.for('analytics.read').runFiguresIncludingPlatform(actor, tenantId, 'read', work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new AnalyticsRefused(e.reason, tenantId);
      throw e;
    }
  }
}
