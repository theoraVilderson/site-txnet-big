import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { FxRateSnapshot } from './gateway-pricing';

/**
 * F-092-c — the **read** side of the FX loop, and the last piece ADR-0019 asks
 * for before a rial gateway can quote at all.
 *
 * The worker has published a rate since F-0606-a and `priceAtGateway` has
 * recorded which snapshot priced a payment since F-0606-b; what was missing
 * between them was anybody reading the key. Until this class,
 * `DepositQuoteService` passed `liveRate: null` and every `useLiveRate` gateway
 * either fell back to its own `staticRate` or refused the quote.
 *
 * **Cache first, table second, and it must be both** (`contract.fx-worker.md`).
 * `fx:rate:{code}` is a cache of a `currency.currency_exchange_rate` row, not a
 * second copy of the number, so a miss is a question for the table and never an
 * answer of its own. The key carries no TTL precisely so the row's age survives
 * for F-0607-a to read.
 *
 * **It never throws, and that is the whole of its error handling.** Every way
 * of having no rate — Redis down, a value that no longer parses, no `currency`
 * row, no snapshot ever written — comes back as `null`, which `rateOf` turns
 * into the gateway's `staticRate` or a `RateUnavailable` the edge answers
 * **503** `billing.gatewayUnavailable`. A throw here would be a 500 on a quote
 * instead, and the user's move is the same either way: another gateway.
 *
 * **A rate with no snapshot behind it is refused, not repaired.** ADR-0019's
 * one forbidden state, and `priceAtGateway` treats it as a caller bug
 * (`InvalidPricingInput`). A cached value missing its id, or holding a rate
 * that is not a positive number, is therefore treated exactly like a cache
 * miss — the table is asked, and only then is there no rate.
 *
 * **It does not judge the rate's age.** The staleness ladder is F-0607-a's and
 * reads the `effectiveAt` this class deliberately leaves on the snapshot; this
 * one answers the rate the platform last accepted, which is the rung the ladder
 * starts from.
 */
@Injectable()
export class FxRateReader {
  private readonly logger = new Logger(FxRateReader.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** The currency the worker quotes in — the same config key it publishes under. */
  private code(): string {
    return this.config.get<string>('FX_QUOTE_CURRENCY_CODE', 'IRR');
  }

  /** The rate the platform last accepted, or `null` when there is none to have. */
  async current(): Promise<FxRateSnapshot | null> {
    const code = this.code();
    return (await this.fromCache(code)) ?? (await this.fromTable(code));
  }

  private async fromCache(code: string): Promise<FxRateSnapshot | null> {
    try {
      const hit = await this.redis.get(UnscopedRedisKeys.fxRate(code));
      if (!hit) return null;
      const { snapshotId, rate } = JSON.parse(hit) as Partial<{ snapshotId: string; rate: string }>;
      return usable(snapshotId, rate);
    } catch (err) {
      // A cache that is unreadable, or holds something this build no longer
      // understands, is a cache miss. Reporting "no rate" from here would drop
      // every live-rate gateway to its `staticRate` for as long as Redis was
      // down, quietly and at whatever price that column happens to name.
      this.logger.warn(
        `fx rate cache unusable, falling back to the snapshot table: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async fromTable(code: string): Promise<FxRateSnapshot | null> {
    // No tenant is bound for this read and none is needed: `currency_exchange_rate`
    // has no `tenantId` and therefore no RLS policy — the rate is the platform's,
    // and every tenant prices from the same one.
    const currency = await this.prisma.currency.findUnique({ where: { code }, select: { id: true } });
    if (!currency) {
      // Reference data neither this service nor the worker will invent
      // (`contract.fx-worker.md`). For the worker that is a failed run; here it
      // is a gateway that cannot price, which is a 503 and not a 500.
      this.logger.warn(`no currency row with code "${code}" — no live rate can be read`);
      return null;
    }

    // "The current rate" is the newest `effectiveAt`, which the
    // `[currencyId, effectiveAt desc]` index answers. The table is append-only
    // (invariant #3), so this is a read of history's last row, never of a flag.
    const latest = await this.prisma.currencyExchangeRate.findFirst({
      where: { currencyId: currency.id, isActive: true },
      orderBy: { effectiveAt: 'desc' },
      select: { id: true, rate: true },
    });

    return latest ? usable(latest.id, latest.rate) : null;
  }
}

/** A snapshot the pricer will accept, or nothing. Both halves or neither (ADR-0019). */
function usable(snapshotId: string | undefined, rate: Prisma.Decimal | string | undefined): FxRateSnapshot | null {
  if (!snapshotId || snapshotId.trim() === '' || rate === undefined || rate === null) return null;
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(rate);
  } catch {
    return null;
  }
  return value.gt(0) ? { snapshotId, rate: value } : null;
}
