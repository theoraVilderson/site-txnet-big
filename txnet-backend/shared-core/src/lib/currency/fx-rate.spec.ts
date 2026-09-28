import { Prisma, RateSource } from '@prisma/client';

import { FX_PIVOT_CURRENCY, readFxPair, readFxRate } from './fx-rate';

/**
 * F-116-c — any currency to any other through the USD pivot (ADR-0098 part 6).
 *
 * A `currency_exchange_rate` row is USD -> code and nothing else, so a pair is
 * `rate(to) / rate(from)`, each leg at its own snapshot. What earns this file
 * its slot is the arithmetic direction (a pair inverted is a price off by the
 * square of the rate), the pivot having no snapshot of its own, and the rule
 * the single-currency read already held for billing: a leg with no snapshot
 * behind it makes the whole pair `null`, never a guess.
 */
type Row = { id: string; rate: Prisma.Decimal; effectiveAt: Date };

const AT = new Date('2026-09-28T09:00:00.000Z');

function stores(options: {
  cache?: Record<string, string>;
  table?: Record<string, Row | null>;
  redisDown?: boolean;
}) {
  const reads = { get: [] as string[], table: [] as string[] };
  const cache = {
    get: async (key: string) => {
      reads.get.push(key);
      if (options.redisDown) throw new Error('ECONNREFUSED');
      return options.cache?.[key] ?? null;
    },
  };
  const db = {
    currency: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        options.table && where.code in options.table ? { id: `cur-${where.code}` } : null,
    },
    currencyExchangeRate: {
      findFirst: async ({ where }: { where: { currencyId: string } }) => {
        const code = where.currencyId.replace(/^cur-/, '');
        reads.table.push(code);
        return options.table?.[code] ?? null;
      },
    },
  };
  return { reads, db: db as never, cache };
}

const cached = (code: string, rate: string, snapshotId = `snap-${code}`) =>
  JSON.stringify({ snapshotId, currencyCode: code, rate, source: RateSource.external_api, effectiveAt: AT.toISOString() });

const row = (id: string, rate: string): Row => ({ id, rate: new Prisma.Decimal(rate), effectiveAt: AT });

describe('readFxRate — one currency, cache first', () => {
  it('answers the cached snapshot with its code and age', async () => {
    const { db, cache, reads } = stores({ cache: { 'fx:rate:IRR': cached('IRR', '1042500') } });

    const snap = await readFxRate(db, cache, 'IRR');

    expect(snap).toEqual({ snapshotId: 'snap-IRR', currencyCode: 'IRR', rate: new Prisma.Decimal('1042500'), effectiveAt: AT });
    expect(reads.table).toEqual([]);
  });

  it('falls through to the newest row when Redis is down', async () => {
    const { db, cache } = stores({ redisDown: true, table: { EUR: row('r-eur', '0.92') } });

    expect((await readFxRate(db, cache, 'EUR'))?.snapshotId).toBe('r-eur');
  });

  it('treats a cached value for another currency as a miss', async () => {
    const { db, cache } = stores({ cache: { 'fx:rate:EUR': cached('IRR', '1042500') }, table: { EUR: row('r-eur', '0.92') } });

    expect((await readFxRate(db, cache, 'EUR'))?.rate.toString()).toBe('0.92');
  });

  it('answers null for a currency with no row and none published', async () => {
    const { db, cache } = stores({ table: {} });

    expect(await readFxRate(db, cache, 'TRY')).toBeNull();
  });
});

describe('readFxPair — through the USD pivot', () => {
  it('divides the target leg by the source leg, each at its own snapshot', async () => {
    const { db, cache } = stores({
      cache: { 'fx:rate:IRR': cached('IRR', '1035000'), 'fx:rate:EUR': cached('EUR', '0.9') },
    });

    const pair = await readFxPair(db, cache, 'EUR', 'IRR');

    // 1 EUR = 1,035,000 / 0.9 = 1,150,000 IRR — not 0.9 / 1,035,000.
    expect(pair?.rate.toString()).toBe('1150000');
    expect(pair?.from?.snapshotId).toBe('snap-EUR');
    expect(pair?.to?.snapshotId).toBe('snap-IRR');
  });

  it('gives the pivot no snapshot and reads only the other leg', async () => {
    const { db, cache, reads } = stores({ cache: { 'fx:rate:IRR': cached('IRR', '1042500') } });

    const pair = await readFxPair(db, cache, FX_PIVOT_CURRENCY, 'IRR');

    expect(pair?.rate.toString()).toBe('1042500');
    expect(pair?.from).toBeNull();
    expect(reads.get).toEqual(['fx:rate:IRR']);
  });

  it('inverts the leg when the pivot is the target', async () => {
    const { db, cache } = stores({ cache: { 'fx:rate:EUR': cached('EUR', '0.8') } });

    expect((await readFxPair(db, cache, 'EUR', 'USD'))?.rate.toString()).toBe('1.25');
  });

  it('is exactly 1 with no read at all for a currency to itself', async () => {
    const { db, cache, reads } = stores({});

    const pair = await readFxPair(db, cache, 'IRR', 'IRR');

    expect(pair).toEqual({ fromCode: 'IRR', toCode: 'IRR', rate: new Prisma.Decimal(1), from: null, to: null });
    expect(reads.get).toEqual([]);
  });

  it('is null when either leg has no rate, never half a pair', async () => {
    const { db, cache } = stores({ cache: { 'fx:rate:IRR': cached('IRR', '1042500') }, table: { TRY: null } });

    expect(await readFxPair(db, cache, 'TRY', 'IRR')).toBeNull();
  });
});
