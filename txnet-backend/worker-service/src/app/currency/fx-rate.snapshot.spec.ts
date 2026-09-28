import { Prisma } from '@prisma/client';
import { FxRateSnapshotStore, FxQuoteCurrencyMissing } from './fx-rate.snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * F-0606-a — step 4 of the FX loop, and the first step of it that **publishes**
 * anything. Everything before this computed a number and put it in a log.
 *
 * Two invariants are stated here, and they are the two that are impossible to
 * see afterwards:
 *
 * 1. **The rate table is append-only** (currency invariant #3). A snapshot is
 *    an `INSERT` and never an `UPDATE`, and no earlier row is touched on the
 *    way past — not even its `isActive` flag. A rate that was quoted has to
 *    stay exactly as it was quoted, because F-0606-b is about to point invoices
 *    at these rows by id and a dispute is settled by reading one back.
 * 2. **The snapshot is the truth and Redis is a cache of it.** The row is
 *    written first and the key second; a reader that misses the key falls back
 *    to the table rather than concluding there is no rate. The opposite order
 *    would publish a rate that no snapshot backs, which is precisely the thing
 *    ADR-0019 requires on the rial path.
 *
 * The third thing stated is the absence of a TTL, which looks like an omission
 * and is a decision: F-0607-a's staleness ladder is a function of the snapshot's
 * *age*, so it needs a rate old enough to call degraded. A TTL would delete the
 * evidence the ladder is made of and turn "15-60 minutes old, degraded" into
 * "no rate at all" — the bottom rung — without anything failing.
 */
describe('FxRateSnapshotStore', () => {
  const CURRENCY = { id: 'currency-irr', code: 'IRR' };
  const SNAPSHOT_ID = 'snap-1';
  const EFFECTIVE_AT = new Date('2026-09-12T10:00:00Z');

  /**
   * A Prisma double that records every call, so that "nothing else was
   * touched" can be asserted rather than assumed — an `update` slipped in
   * beside the `create` is the shape invariant #3 dies in.
   */
  const prismaWith = (currency: unknown, latest: unknown = null) => {
    const calls: string[] = [];
    const created: unknown[] = [];
    return {
      calls,
      created,
      prisma: {
        currency: {
          findUnique: vi.fn(async () => {
            calls.push('currency.findUnique');
            return currency;
          }),
        },
        currencyExchangeRate: {
          create: vi.fn(async (args: { data: Record<string, unknown> }) => {
            calls.push('rate.create');
            created.push(args.data);
            return {
              id: SNAPSHOT_ID,
              effectiveAt: EFFECTIVE_AT,
              ...args.data,
            };
          }),
          update: vi.fn(async () => {
            calls.push('rate.update');
            return {};
          }),
          updateMany: vi.fn(async () => {
            calls.push('rate.updateMany');
            return {};
          }),
          findFirst: vi.fn(async () => {
            calls.push('rate.findFirst');
            return latest;
          }),
        },
      } as unknown as PrismaService,
    };
  };

  const redisWith = (stored: Record<string, string> = {}) => {
    const sets: Array<{ key: string; value: string; rest: unknown[] }> = [];
    return {
      sets,
      stored,
      redis: {
        client: {
          get: vi.fn(async (key: string) => stored[key] ?? null),
          set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
            sets.push({ key, value, rest });
            stored[key] = value;
            return 'OK';
          }),
        },
      } as unknown as RedisService,
    };
  };

  it('inserts a snapshot and touches no earlier row', async () => {
    const { prisma, calls, created } = prismaWith(CURRENCY);
    const { redis } = redisWith();
    const store = new FxRateSnapshotStore(prisma, redis);

    const { snapshot, cached } = await store.publish('IRR',
      new Prisma.Decimal('1075000'),
    );

    expect(snapshot.id).toBe(SNAPSHOT_ID);
    expect(cached).toBe(true);
    expect(created).toEqual([
      {
        currencyId: CURRENCY.id,
        rate: expect.any(Prisma.Decimal),
        source: 'external_api',
      },
    ]);
    expect((created[0] as { rate: Prisma.Decimal }).rate.toString()).toBe(
      '1075000',
    );
    // The whole of invariant #3 in one assertion: no update of any shape ran.
    expect(calls).toEqual(['currency.findUnique', 'rate.create']);
  });

  it('caches the snapshot under fx:rate:{code}, with no expiry', async () => {
    const { prisma } = prismaWith(CURRENCY);
    const { redis, sets } = redisWith();
    const store = new FxRateSnapshotStore(prisma, redis);

    await store.publish('IRR', new Prisma.Decimal('1075000'));

    expect(sets).toHaveLength(1);
    expect(sets[0].key).toBe('fx:rate:IRR');
    // No `EX`/`PX` argument: the ladder in F-0607-a reads this key's age.
    expect(sets[0].rest).toEqual([]);
    expect(JSON.parse(sets[0].value)).toEqual({
      snapshotId: SNAPSHOT_ID,
      currencyCode: 'IRR',
      rate: '1075000',
      source: 'external_api',
      effectiveAt: EFFECTIVE_AT.toISOString(),
    });
  });

  it('writes the row before the key, so no cached rate lacks a snapshot', async () => {
    const order: string[] = [];
    const prisma = {
      currency: { findUnique: vi.fn(async () => CURRENCY) },
      currencyExchangeRate: {
        create: vi.fn(async () => {
          order.push('snapshot');
          return { id: SNAPSHOT_ID, effectiveAt: EFFECTIVE_AT };
        }),
      },
    } as unknown as PrismaService;
    const redis = {
      client: {
        get: vi.fn(),
        set: vi.fn(async () => {
          order.push('cache');
          return 'OK';
        }),
      },
    } as unknown as RedisService;

    const store = new FxRateSnapshotStore(prisma, redis);
    await store.publish('IRR', new Prisma.Decimal('1075000'));

    expect(order).toEqual(['snapshot', 'cache']);
  });

  it('refuses to invent the currency row it is quoting against', async () => {
    const { prisma, calls } = prismaWith(null);
    const { redis } = redisWith();
    const store = new FxRateSnapshotStore(prisma, redis);

    // Reference data, not this job's to create: a `currency` row carries
    // `isBaseCurrency` and `decimalPlaces`, and a worker guessing at those is
    // how a platform ends up with two base currencies (invariant #1).
    await expect(store.publish('IRR', new Prisma.Decimal('1075000'))).rejects.toThrow(
      FxQuoteCurrencyMissing,
    );
    expect(calls).toEqual(['currency.findUnique']);
  });

  it('rounds to the column\'s eight places once, so the row and the key hold the same rate (F-116-i)', async () => {
    const { prisma, created } = prismaWith({ id: 'currency-eur', code: 'EUR' });
    const { redis, sets } = redisWith();
    const store = new FxRateSnapshotStore(prisma, redis);

    // 1 / 1.13685, an inverted EUR/USDT book: more digits than DECIMAL(18,8).
    const { snapshot } = await store.publish('EUR', new Prisma.Decimal(1).div('1.13685'));

    expect((created[0] as { rate: Prisma.Decimal }).rate.toString()).toBe('0.87962352');
    expect(snapshot.rate).toBe('0.87962352');
    expect(sets[0].key).toBe('fx:rate:EUR');
    expect(JSON.parse(sets[0].value).rate).toBe('0.87962352');
  });

  it('reads the last accepted rate from the cache', async () => {
    const { prisma, calls } = prismaWith(CURRENCY);
    const { redis } = redisWith({
      'fx:rate:IRR': JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        currencyCode: 'IRR',
        rate: '1075000',
        source: 'external_api',
        effectiveAt: EFFECTIVE_AT.toISOString(),
      }),
    });
    const store = new FxRateSnapshotStore(prisma, redis);

    const last = await store.lastAccepted('IRR');

    expect(last!.toString()).toBe('1075000');
    expect(calls).toEqual([]);
  });

  it('falls back to the newest snapshot when the cache is cold', async () => {
    // The hole F-0605 left open and this row closes: after a restart, or on a
    // replica that has never polled, the gate's baseline must still be the
    // last rate the *platform* accepted — not nothing, which is a cold start
    // and ungated.
    const { prisma, calls } = prismaWith(CURRENCY, {
      id: SNAPSHOT_ID,
      rate: new Prisma.Decimal('1075000'),
      effectiveAt: EFFECTIVE_AT,
    });
    const { redis } = redisWith();
    const store = new FxRateSnapshotStore(prisma, redis);

    const last = await store.lastAccepted('IRR');

    expect(last!.toString()).toBe('1075000');
    expect(calls).toEqual(['currency.findUnique', 'rate.findFirst']);
  });

  it('has no baseline before the first snapshot, rather than a zero', async () => {
    const { prisma } = prismaWith(CURRENCY, null);
    const { redis } = redisWith();
    const store = new FxRateSnapshotStore(prisma, redis);

    expect(await store.lastAccepted('IRR')).toBeNull();
  });

  it('falls back to the table when the cache read itself fails', async () => {
    // A Redis that is down must not cost the gate its baseline and turn every
    // poll into a cold start — the ungated one. The snapshot table is the
    // durable half of this pair, and it is still there.
    const { prisma, calls } = prismaWith(CURRENCY, {
      id: SNAPSHOT_ID,
      rate: new Prisma.Decimal('1075000'),
      effectiveAt: EFFECTIVE_AT,
    });
    const redis = {
      client: {
        get: vi.fn(async () => {
          throw new Error('connection refused');
        }),
        set: vi.fn(async () => 'OK'),
      },
    } as unknown as RedisService;
    const store = new FxRateSnapshotStore(prisma, redis);

    const last = await store.lastAccepted('IRR');

    expect(last!.toString()).toBe('1075000');
    expect(calls).toEqual(['currency.findUnique', 'rate.findFirst']);
  });

  it('keeps a rate whose cache write failed, and says it is uncached', async () => {
    // The other direction, and the reason `publish` reports rather than
    // throws: the snapshot is already durable when the key fails, so throwing
    // would report a run that published nothing when it published the rate.
    // `cached: false` is what the job turns into a non-zero `errorsCount`.
    const { prisma } = prismaWith(CURRENCY);
    const redis = {
      client: {
        get: vi.fn(),
        set: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      },
    } as unknown as RedisService;
    const store = new FxRateSnapshotStore(prisma, redis);

    const published = await store.publish('IRR', new Prisma.Decimal('1075000'));

    expect(published.snapshot.id).toBe(SNAPSHOT_ID);
    expect(published.cached).toBe(false);
  });
});
