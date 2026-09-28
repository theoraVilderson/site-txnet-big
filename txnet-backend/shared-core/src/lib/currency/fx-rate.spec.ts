import { Prisma, RateSource } from '@prisma/client';

import { DERIVED_CURRENCIES, FX_PIVOT_CURRENCY, readFxPair, readFxRate } from './fx-rate';

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
type Row = { id: string; rate: Prisma.Decimal; effectiveAt: Date; reason?: string; expiresAt?: Date };

const AT = new Date('2026-09-28T09:00:00.000Z');

function stores(options: {
  cache?: Record<string, string>;
  table?: Record<string, Row | null>;
  /** A live platform pin per code (F-0608-a); `'throw'` makes the pin query fail. */
  pins?: Record<string, Row | 'throw'>;
  /** A live pin per `tenantId:code` (F-116-j). */
  tenantPins?: Record<string, Row>;
  redisDown?: boolean;
}) {
  const reads = { get: [] as string[], table: [] as string[], pins: [] as string[], where: [] as unknown[] };
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
        (options.table && where.code in options.table) ||
        (options.pins && where.code in options.pins) ||
        Object.keys(options.tenantPins ?? {}).some((k) => k.endsWith(`:${where.code}`))
          ? { id: `cur-${where.code}` }
          : null,
    },
    currencyExchangeRate: {
      findFirst: async ({ where }: { where: { currencyId: string; source?: string } }) => {
        const code = where.currencyId.replace(/^cur-/, '');
        if (where.source === RateSource.manual_admin) {
          reads.pins.push(code);
          reads.where.push(where);
          const pin = options.pins?.[code];
          if (pin === 'throw') throw new Error('db down');
          // The reader asks `tenantId: X OR null`, tenant first; this double
          // answers the same order.
          const tenants = ((where as { OR?: { tenantId: string | null }[] }).OR ?? [{ tenantId: (where as { tenantId?: null }).tenantId ?? null }])
            .map((o) => o.tenantId)
            .filter((t): t is string => !!t);
          for (const t of tenants) if (options.tenantPins?.[`${t}:${code}`]) return options.tenantPins[`${t}:${code}`];
          return pin ?? null;
        }
        reads.table.push(code);
        reads.where.push(where);
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

  it('answers a live pin before the cache and the table, marked as pinned (F-0608-a)', async () => {
    const until = new Date('2026-09-30T09:00:00.000Z');
    const { db, cache, reads } = stores({
      cache: { 'fx:rate:EUR': cached('EUR', '0.87') },
      table: { EUR: row('r-eur', '0.87') },
      pins: { EUR: { ...row('pin-eur', '0.95'), reason: 'sources down', expiresAt: until } },
    });

    const snap = await readFxRate(db, cache, 'EUR');

    expect(snap).toMatchObject({ snapshotId: 'pin-eur', rate: new Prisma.Decimal('0.95'), pinned: { reason: 'sources down', expiresAt: until } });
    expect(reads.get).toEqual([]);
  });

  it('reads only discovered rates from the table, never an expired or ended pin', async () => {
    const { db, cache, reads } = stores({ redisDown: true, table: { EUR: row('r-eur', '0.87') } });

    await readFxRate(db, cache, 'EUR');

    expect(reads.where).toContainEqual(expect.objectContaining({ source: RateSource.external_api }));
  });

  it('answers a pin with no end, and asks the table for one (F-116-n)', async () => {
    const { db, cache, reads } = stores({
      pins: { IRR: { ...row('pin-open', '1300000'), reason: 'our price', expiresAt: null as unknown as Date } },
    });

    const snap = await readFxRate(db, cache, 'IRR');

    expect(snap).toMatchObject({ snapshotId: 'pin-open', pinned: { reason: 'our price', expiresAt: null } });
    expect(JSON.stringify(reads.where[0])).toContain('"expiresAt":null');
  });

  it('falls through to the live rate, with a warning, when the pin cannot be read', async () => {
    const warn = vi.fn();
    const { db, cache } = stores({ cache: { 'fx:rate:EUR': cached('EUR', '0.87') }, pins: { EUR: 'throw' } });

    expect((await readFxRate(db, cache, 'EUR', { warn }))?.snapshotId).toBe('snap-EUR');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pin/));
  });

  it('answers a tenant its own pin first, then the platform pin (F-116-j)', async () => {
    const until = new Date('2026-09-30T09:00:00.000Z');
    const { db, cache } = stores({
      cache: { 'fx:rate:IRR': cached('IRR', '2440000') },
      pins: { IRR: { ...row('pin-platform', '2500000'), reason: 'platform', expiresAt: until } },
      tenantPins: { 't-1:IRR': { ...row('pin-t1', '2600000'), reason: 'reseller', expiresAt: until } },
    });

    expect((await readFxRate(db, cache, 'IRR', undefined, { tenantId: 't-1' }))?.snapshotId).toBe('pin-t1');
    expect((await readFxRate(db, cache, 'IRR', undefined, { tenantId: 't-2' }))?.snapshotId).toBe('pin-platform');
  });

  it('never answers a tenant pin to a read with no tenant — the tenant <-> platform boundary', async () => {
    const until = new Date('2026-09-30T09:00:00.000Z');
    const { db, cache, reads } = stores({
      cache: { 'fx:rate:IRR': cached('IRR', '2440000') },
      table: { IRR: row('r-irr', '2440000') },
      tenantPins: { 't-1:IRR': { ...row('pin-t1', '2600000'), reason: 'reseller', expiresAt: until } },
    });

    expect((await readFxRate(db, cache, 'IRR'))?.snapshotId).toBe('snap-IRR');
    expect(reads.where).toContainEqual(expect.objectContaining({ source: RateSource.manual_admin, tenantId: null }));
  });

  it('binds exactly the named tenant for its pin, in a transaction, when given a service', async () => {
    const until = new Date('2026-09-30T09:00:00.000Z');
    const { db, cache } = stores({
      cache: { 'fx:rate:IRR': cached('IRR', '2440000') },
      tenantPins: { 't-1:IRR': { ...row('pin-t1', '2600000'), reason: 'reseller', expiresAt: until } },
    });
    const bound: unknown[] = [];
    const service = Object.assign(Object.create(null), db as object, {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ ...(db as object), $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => bound.push(...v) }),
    });

    expect((await readFxRate(service, cache, 'IRR', undefined, { tenantId: 't-1' }))?.snapshotId).toBe('pin-t1');
    expect(bound).toEqual(['t-1']);
  });

  it('carries the tenant to both legs of a pair', async () => {
    const until = new Date('2026-09-30T09:00:00.000Z');
    const { db, cache } = stores({
      cache: { 'fx:rate:IRR': cached('IRR', '2440000'), 'fx:rate:EUR': cached('EUR', '0.88') },
      tenantPins: { 't-1:IRR': { ...row('pin-t1', '2600000'), reason: 'reseller', expiresAt: until } },
    });

    const pair = await readFxPair(db, cache, 'EUR', 'IRR', undefined, { tenantId: 't-1' });

    expect(pair?.to?.snapshotId).toBe('pin-t1');
    expect(pair?.from?.snapshotId).toBe('snap-EUR');
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

/**
 * F-116-m — the toman is the rial divided by ten, and never a rate of its own
 * (user, 2026-09-28). IRT reads IRR's snapshot and divides; a rial pin moves
 * it, and a pair between the two is the exact ratio, never two reads that a
 * worker tick could land between.
 */
describe('a currency tied to another (IRT = IRR / 10)', () => {
  it('is declared once, against the rial', () => {
    expect(DERIVED_CURRENCIES['IRT']).toEqual({ of: 'IRR', divisor: 10 });
  });

  it("reads the rial's snapshot, divided, and records the rial's row", async () => {
    const { db, cache, reads } = stores({ cache: { 'fx:rate:IRR': cached('IRR', '1042500') } });

    const snap = await readFxRate(db, cache, 'IRT');

    expect(snap).toMatchObject({ snapshotId: 'snap-IRR', currencyCode: 'IRT' });
    expect(snap!.rate.toString()).toBe('104250');
    expect(reads.get).toEqual(['fx:rate:IRR']);
  });

  it('follows a rial pin, marked as pinned', async () => {
    const { db, cache } = stores({ pins: { IRR: { ...row('pin-1', '1200000'), reason: 'market', expiresAt: new Date(Date.now() + 3600e3) } } });

    const snap = await readFxRate(db, cache, 'IRT');

    expect(snap!.rate.toString()).toBe('120000');
    expect(snap!.pinned?.reason).toBe('market');
  });

  it('never reads a pin or a row of its own', async () => {
    const { db, cache, reads } = stores({ table: { IRR: row('r-1', '1000000'), IRT: row('r-own', '1') } });

    const snap = await readFxRate(db, cache, 'IRT');

    expect(snap!.rate.toString()).toBe('100000');
    expect([...reads.pins, ...reads.table]).not.toContain('IRT');
  });

  it('is null when the rial has no rate', async () => {
    const { db, cache } = stores({});
    expect(await readFxRate(db, cache, 'IRT')).toBeNull();
  });

  it('prices a rial <-> toman pair at exactly the ratio, from one rial read', async () => {
    const { db, cache, reads } = stores({ cache: { 'fx:rate:IRR': cached('IRR', '1042500') } });

    const pair = await readFxPair(db, cache, 'IRR', 'IRT');

    expect(pair!.rate.toString()).toBe('0.1');
    expect(pair!.from!.snapshotId).toBe(pair!.to!.snapshotId);
    expect(reads.get).toEqual(['fx:rate:IRR']);
    expect((await readFxPair(db, cache, 'IRT', 'IRR'))!.rate.toString()).toBe('10');
  });

  it('crosses to any other currency through the pivot as the rial does', async () => {
    const { db, cache } = stores({ cache: { 'fx:rate:IRR': cached('IRR', '1000000'), 'fx:rate:EUR': cached('EUR', '0.9') } });

    const pair = await readFxPair(db, cache, 'EUR', 'IRT');

    expect(pair!.rate.toString()).toBe('111111.11111111111111');
  });
});
