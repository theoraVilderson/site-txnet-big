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

  async list(): Promise<CurrencyRate[]> {
    const currencies = await this.prisma.currency.findMany({
      where: { isActive: true },
      select: { code: true, name: true, symbol: true, decimalPlaces: true, isBaseCurrency: true },
      orderBy: { code: 'asc' },
    });

    const rows = await Promise.all(
      currencies.map(async (c): Promise<CurrencyRate> => {
        const base = { code: c.code, name: c.name, symbol: c.symbol, decimalPlaces: c.decimalPlaces, isBase: c.isBaseCurrency };
        if (c.isBaseCurrency) return { ...base, rate: '1', snapshotId: null, effectiveAt: null };
        const snapshot = await readFxRate(this.prisma as unknown as FxRateDb, this.redis, c.code, this.logger);
        return snapshot
          ? { ...base, rate: snapshot.rate.toString(), snapshotId: snapshot.snapshotId, effectiveAt: snapshot.effectiveAt.toISOString() }
          : { ...base, rate: null, snapshotId: null, effectiveAt: null };
      }),
    );
    return rows.sort((a, b) => a.code.localeCompare(b.code));
  }
}
