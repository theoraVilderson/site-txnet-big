import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RateSource } from '@prisma/client';
import { RedisKeys } from '../redis/redis.keys';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** What the cache holds, and what a reader of a rate is actually handed. */
export interface FxSnapshot {
  /** `currency.CurrencyExchangeRate.id` — the id F-0606-b stamps on a price. */
  snapshotId: string;
  currencyCode: string;
  /** Rial per one base unit, as a decimal string (C-02 — never a float). */
  rate: string;
  source: RateSource;
  /** When this rate started applying. F-0607-a's ladder is a function of it. */
  effectiveAt: string;
}

/** A snapshot that is durable, and whether the cache of it is up to date. */
export interface FxPublished {
  snapshot: FxSnapshot & { id: string };
  cached: boolean;
}

/**
 * The quoted currency has no `currency` row. Reference data this job will not
 * invent — see `publish`.
 */
export class FxQuoteCurrencyMissing extends Error {
  constructor(readonly code: string) {
    super(
      `no currency row with code "${code}" — the FX snapshot has nothing to ` +
        `hang on; seed the currency table (FX_QUOTE_CURRENCY_CODE)`,
    );
    this.name = 'FxQuoteCurrencyMissing';
  }
}

/**
 * F-0606-a — **step 4 of the FX loop, and the first step that publishes
 * anything.** Steps 1 to 3 poll, reduce and gate; until this class existed an
 * accepted rate was a number in a run log that no caller could reach.
 *
 * Two stores, and the order between them is the whole design:
 *
 * - `currency.CurrencyExchangeRate` is the **truth**, and it is append-only
 *   (currency invariant #3). Every accepted rate is one new row and no earlier
 *   row is touched — not its `rate`, not its `isActive`. ADR-0019 makes a rial
 *   gateway impossible without this row, and F-0606-b is about to point quoted
 *   prices at it by id; a dispute six months out is settled by reading one
 *   back, so a rate that was quoted has to stay exactly as it was quoted.
 * - `fx:rate:{currencyCode}` is a **cache of that row**, not a second copy of
 *   the number. It carries the snapshot id and `effectiveAt` precisely so that
 *   a reader can record which snapshot it priced at (F-0606-b) and how old it
 *   is (F-0607-a) without a query.
 *
 * The row is written first and the key second. The other order would publish,
 * for as long as the write took, a rate that no snapshot backs — which is the
 * one state ADR-0019 says the rial path must never be in.
 *
 * **No TTL, and that is a decision rather than an omission.** F-0607-a's
 * staleness ladder is a function of the snapshot's age: under 15 minutes
 * normal, 15-60 the last rate but degraded, over 60 the gateway's `staticRate`.
 * An expiry would delete the evidence that ladder is made of, so a rate the
 * ladder would have called degraded would arrive as no rate at all — the bottom
 * rung — with nothing failing anywhere. The key is overwritten every accepted
 * poll and outlives Redis only as long as Redis outlives itself; the table is
 * what makes that safe.
 *
 * **It also closes F-0605's baseline hole.** The deviation gate's baseline used
 * to live in `FxRateJob`'s memory, so a restart was a cold start (and the first
 * poll after one ungated) and two replicas gated against their own histories.
 * `lastAccepted` reads it from the cache, falling back to the newest snapshot —
 * one shared, durable baseline for every replica, which is what
 * `contract.fx-worker.md` said would happen here.
 */
@Injectable()
export class FxRateSnapshotStore {
  private readonly logger = new Logger(FxRateSnapshotStore.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** The currency the worker quotes in. Config, because D-22's sources are. */
  private code(): string {
    return this.config.get<string>('FX_QUOTE_CURRENCY_CODE', 'IRR');
  }

  /**
   * Write the snapshot, then cache it.
   *
   * **A failed cache write is reported, not thrown.** By the time the key is
   * written the rate is already durable and already the platform's rate, so
   * throwing would record a run that published nothing when it published the
   * rate — and the next accepted poll rewrites the key anyway. `cached: false`
   * is what the job turns into a non-zero `errorsCount`, so the run is visibly
   * degraded rather than quietly so.
   */
  async publish(rate: Prisma.Decimal): Promise<FxPublished> {
    const code = this.code();
    const currency = await this.prisma.currency.findUnique({
      where: { code },
    });

    // Reference data, and deliberately not this job's to create. A `currency`
    // row carries `isBaseCurrency` and `decimalPlaces`; a worker guessing at
    // those is how a platform acquires a second base currency (invariant #1)
    // at three in the morning. A missing row is a failed run with a name in it.
    if (!currency) throw new FxQuoteCurrencyMissing(code);

    // An INSERT and nothing else. No `updateMany` deactivating the previous
    // row: "the current rate" is the newest `effectiveAt`, which the
    // `[currencyId, effectiveAt desc]` index answers, and rewriting history to
    // say so is exactly what invariant #3 forbids.
    const row = await this.prisma.currencyExchangeRate.create({
      data: {
        currencyId: currency.id,
        rate,
        source: RateSource.external_api,
      },
    });

    const snapshot: FxSnapshot = {
      snapshotId: row.id,
      currencyCode: code,
      rate: rate.toString(),
      source: RateSource.external_api,
      effectiveAt: row.effectiveAt.toISOString(),
    };

    let cached = true;
    try {
      await this.redis.client.set(
        RedisKeys.fxRate(code),
        JSON.stringify(snapshot),
      );
    } catch (err) {
      cached = false;
      this.logger.error(
        `snapshot ${row.id} written but not cached: ${(err as Error).message}`,
      );
    }

    return { snapshot: { ...snapshot, id: row.id }, cached };
  }

  /**
   * The last rate the **platform** accepted — F-0605's baseline, now shared
   * and durable rather than per-process.
   *
   * Cache first, table second, and a Redis that is down falls through to the
   * table rather than failing: a baseline that went missing whenever Redis did
   * would make every poll a cold start, and a cold start is the ungated one.
   * Null only before the first snapshot ever written, which is the one genuine
   * cold start.
   */
  async lastAccepted(): Promise<Prisma.Decimal | null> {
    const code = this.code();

    try {
      const hit = await this.redis.client.get(RedisKeys.fxRate(code));
      if (hit) return new Prisma.Decimal((JSON.parse(hit) as FxSnapshot).rate);
    } catch (err) {
      this.logger.warn(
        `fx rate cache unreadable, falling back to the snapshot table: ${
          (err as Error).message
        }`,
      );
    }

    const currency = await this.prisma.currency.findUnique({ where: { code } });
    if (!currency) throw new FxQuoteCurrencyMissing(code);

    const latest = await this.prisma.currencyExchangeRate.findFirst({
      where: { currencyId: currency.id, isActive: true },
      orderBy: { effectiveAt: 'desc' },
    });

    return latest ? new Prisma.Decimal(latest.rate) : null;
  }
}
