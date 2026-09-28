import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFxRate } from '@txnet-backend/shared-core';

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
 * The read itself is shared-core's `readFxRate` since F-116-c; the rules
 * below are that function's, kept here because this is where they were argued.
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
    // One reader for every service (F-116-c): the cache/table rules below live
    // in shared-core's `readFxRate` now; this keeps the pricer's `{snapshotId, rate}`.
    const snapshot = await readFxRate(this.prisma, this.redis, this.code(), this.logger);
    return snapshot ? { snapshotId: snapshot.snapshotId, rate: snapshot.rate } : null;
  }
}
