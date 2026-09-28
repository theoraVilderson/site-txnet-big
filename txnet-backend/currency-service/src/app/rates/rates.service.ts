import { Injectable, Logger } from '@nestjs/common';
import { FxRateDb, readFxRate } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** One currency and the rate it has now; `rate` null when it has none yet. */
export interface CurrencyRate {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isBase: boolean;
  /** Units of this currency per one USD, as a decimal string (C-02). */
  rate: string | null;
  snapshotId: string | null;
  effectiveAt: string | null;
  /** Set while a person's pin is what prices this currency (F-0608-a). */
  pinned: { reason: string; expiresAt: string | null } | null;
}

/**
 * The current rate of every active currency (F-116-k). Read through
 * shared-core `readFxRate` — the one reader (currency/contract.md) — so this
 * list is what billing prices at. A currency with no rate is listed with
 * `rate: null`: it is the one the manual-rate form is for. Age is not judged
 * here (F-0607-a, ADR-0101).
 */
@Injectable()
export class CurrencyRatesService {
  private readonly logger = new Logger(CurrencyRatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * `tenantId` is the caller's (F-116-j): a tenant sees the rate its own books
   * price at — its own pin first — which is what its gateways charge.
   */
  async list(tenantId: string | null = null): Promise<CurrencyRate[]> {
    const currencies = await this.prisma.currency.findMany({
      where: { isActive: true },
      select: { code: true, name: true, symbol: true, decimalPlaces: true, isBaseCurrency: true },
      orderBy: { code: 'asc' },
    });

    const rows = await Promise.all(
      currencies.map(async (c): Promise<CurrencyRate> => {
        const base = { code: c.code, name: c.name, symbol: c.symbol, decimalPlaces: c.decimalPlaces, isBase: c.isBaseCurrency };
        if (c.isBaseCurrency) return { ...base, rate: '1', snapshotId: null, effectiveAt: null, pinned: null };
        const snapshot = await readFxRate(this.prisma as unknown as FxRateDb, this.redis, c.code, this.logger, { tenantId });
        return snapshot
          ? {
              ...base,
              rate: snapshot.rate.toString(),
              snapshotId: snapshot.snapshotId,
              effectiveAt: snapshot.effectiveAt.toISOString(),
              pinned: snapshot.pinned
                ? { reason: snapshot.pinned.reason, expiresAt: snapshot.pinned.expiresAt?.toISOString() ?? null }
                : null,
            }
          : { ...base, rate: null, snapshotId: null, effectiveAt: null, pinned: null };
      }),
    );
    return rows.sort((a, b) => a.code.localeCompare(b.code));
  }
}
