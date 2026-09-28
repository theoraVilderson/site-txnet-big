import { Prisma, RateSource } from '@prisma/client';

import { FxRateReader } from './fx-rate.reader';

/**
 * The read side of the FX loop (F-092-c) — the half `contract.fx-worker.md`
 * called missing: the worker has published `fx:rate:{code}` since F-0606-a, and
 * until this class nothing read it, so every gateway priced from its own
 * `staticRate` or refused.
 *
 * What earns this file its slot is that both stores have to be tried and
 * neither may take a quote down. The key is a *cache* of the snapshot row, so a
 * Redis that is down or a value that no longer parses must fall through to the
 * table rather than answer "no rate" — the answer that silently drops every
 * live-rate gateway to its `staticRate`. And the failure that matters most is
 * the one ADR-0019 forbids outright: a rate with no snapshot behind it. This
 * reader refuses to hand one to the pricer, because `priceAtGateway` treats it
 * as a caller bug and throws `InvalidPricingInput` — a 500 on a quote, where
 * `null` is a 503 the user can act on.
 */
const SNAPSHOT_ID = '8f2a6c21-0c51-4c2e-9f3a-11d0b9b6f001';
const ROW_ID = '3c7e1f90-55aa-4b1d-88e1-77c0a2d4e002';
const CURRENCY_ID = 'b1d9a7c4-2e60-4a88-9c22-6f0e5a3b1003';

const cached = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    snapshotId: SNAPSHOT_ID,
    currencyCode: 'IRR',
    rate: '1042500.00000000',
    source: RateSource.external_api,
    effectiveAt: '2026-09-12T09:00:00.000Z',
    ...over,
  });

function reader(options: {
  hit?: string | null;
  redisError?: Error;
  currency?: { id: string } | null;
  row?: { id: string; rate: Prisma.Decimal; effectiveAt: Date } | null;
  code?: string;
}) {
  const calls = { get: [] as string[], findFirst: 0 };
  const redis = {
    get: async (key: string) => {
      calls.get.push(key);
      if (options.redisError) throw options.redisError;
      return options.hit ?? null;
    },
  };
  const prisma = {
    currency: {
      findUnique: async () => options.currency ?? { id: CURRENCY_ID },
    },
    currencyExchangeRate: {
      findFirst: async () => {
        calls.findFirst += 1;
        return options.row ?? null;
      },
    },
  };
  const config = { get: (_k: string, fallback: string) => options.code ?? fallback };
  return {
    calls,
    fx: new FxRateReader(
      config as never,
      prisma as never,
      redis as never,
    ),
  };
}

const row = (rate: string) => ({ id: ROW_ID, rate: new Prisma.Decimal(rate), effectiveAt: new Date('2026-09-12T09:00:00.000Z') });

describe('FxRateReader — the cache', () => {
  it('answers the cached snapshot without touching the table', async () => {
    const { fx, calls } = reader({ hit: cached() });

    const snapshot = await fx.current();

    expect(snapshot?.snapshotId).toBe(SNAPSHOT_ID);
    expect(snapshot?.rate.toString()).toBe('1042500');
    expect(calls.findFirst).toBe(0);
  });

  it('reads the key the worker writes, under the configured currency code', async () => {
    const { fx, calls } = reader({ hit: cached({ currencyCode: 'TRY' }), code: 'TRY' });

    await fx.current();

    expect(calls.get).toEqual(['fx:rate:TRY']);
  });
});

describe('FxRateReader — falling through to the table', () => {
  it('reads the newest snapshot row when the key is missing', async () => {
    const { fx } = reader({ hit: null, row: row('1041000') });

    const snapshot = await fx.current();

    expect(snapshot).toEqual({ snapshotId: ROW_ID, rate: new Prisma.Decimal('1041000') });
  });

  it('falls through when Redis is down rather than reporting no rate', async () => {
    const { fx, calls } = reader({ redisError: new Error('ECONNREFUSED'), row: row('1041000') });

    const snapshot = await fx.current();

    expect(snapshot?.snapshotId).toBe(ROW_ID);
    expect(calls.findFirst).toBe(1);
  });

  it('falls through when the cached value no longer parses', async () => {
    const { fx, calls } = reader({ hit: '{not json', row: row('1041000') });

    expect((await fx.current())?.snapshotId).toBe(ROW_ID);
    expect(calls.findFirst).toBe(1);
  });

  it('answers null when the platform has never published a rate', async () => {
    const { fx } = reader({ hit: null, row: null });

    expect(await fx.current()).toBeNull();
  });

  it('answers null, and does not throw, when the quoted currency has no row', async () => {
    const { fx } = reader({ hit: null, currency: null });

    expect(await fx.current()).toBeNull();
  });
});

describe('FxRateReader — what it refuses to hand to the pricer', () => {
  it('falls through when the cached snapshot carries no id', async () => {
    const { fx } = reader({ hit: cached({ snapshotId: '  ' }), row: row('1041000') });

    expect((await fx.current())?.snapshotId).toBe(ROW_ID);
  });

  it('falls through when the cached rate is not a positive number', async () => {
    const { fx } = reader({ hit: cached({ rate: '0' }), row: row('1041000') });

    expect((await fx.current())?.snapshotId).toBe(ROW_ID);
  });

  it('answers null rather than a rate the table cannot back either', async () => {
    const { fx } = reader({ hit: cached({ rate: '-1' }), row: row('0') });

    expect(await fx.current()).toBeNull();
  });
});
