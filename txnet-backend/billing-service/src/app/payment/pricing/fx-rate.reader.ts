import { Injectable, Logger } from '@nestjs/common';
import { readFxPair } from '@txnet-backend/shared-core';

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
 * The read itself is shared-core's `readFxPair` since F-116-c/F-116-e: the
 * payer's currency to the gateway's charge currency through the USD pivot, a
 * leg per snapshot. The rules below are shared-core's, kept here because this
 * is where they were argued.
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
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * `from` -> `to` as the platform last accepted it, and both legs' snapshots,
   * or `null` when either leg has no rate. `to` is the gateway's charge
   * currency, whose leg `exchangeRateSnapshotId` records; `from` is the payer's.
   */
  async pair(from: string, to: string): Promise<FxRateSnapshot | null> {
    const pair = await readFxPair(this.prisma, this.redis, from, to, this.logger);
    return pair ? { snapshotId: pair.to?.snapshotId ?? null, fromSnapshotId: pair.from?.snapshotId ?? null, rate: pair.rate } : null;
  }
}
