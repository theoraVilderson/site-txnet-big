import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Mock } from 'vitest';
import { FxRatePoller } from '../currency/fx-rate.poller';
import { FxQuoteCurrencyMissing, FxRateSnapshotStore } from '../currency/fx-rate.snapshot';
import { FX_SOURCES } from '../currency/fx-source';
import { FxRateJob } from './fx-rate.job';

/**
 * F-116-i (ADR-0098 part 8, D-51) — **the FX loop runs once per currency**.
 *
 * Each currency is its own sample: its own sources, its own sanity band, its
 * own median, its own deviation gate against its own last accepted rate, and
 * its own snapshot. What this spec holds is the part a per-currency loop can
 * get wrong and a single-currency one could not:
 *
 * 1. **Every source is normalised to "units of the currency per one USD"**,
 *    whatever its book is quoted in — a USDT/EUR book as it stands, a EUR/USDT
 *    book inverted, and an Iranian market's rial price of one euro divided
 *    into **this tick's accepted** USDT/IRT rate.
 * 2. **A derived source never uses a rate the gate did not accept.** If IRR is
 *    refused or short this tick, the rial-quoted sources of every other
 *    currency fail; the foreign books still carry it.
 * 3. **One currency's failure is that currency's.** A shortfall, a refusal or
 *    a missing `currency` row costs its own rate and nothing else, and the run
 *    keeps the numbers of all of them (`metrics.currencies`).
 * 4. **A source is only ever read for the currency it rates.**
 */
describe('FxRateJob — one loop per currency (F-116-i)', () => {
  const D = (v: string) => new Prisma.Decimal(v);
  const url = (key: string) => FX_SOURCES.find((s) => s.key === key)!.url;

  let fetchMock: Mock;
  /** url -> JSON body; an absent url answers 503. */
  let bodies: Record<string, unknown>;

  const book = (bid: string, ask: string) => ({
    bids: [[bid, '1']],
    asks: [[ask, '1']],
  });

  beforeEach(() => {
    bodies = {};
    fetchMock = vi.fn(async (u: string) =>
      u in bodies
        ? ({ ok: true, status: 200, json: async () => bodies[u] } as Response)
        : ({ ok: false, status: 503, json: async () => ({}) } as Response),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => vi.restoreAllMocks());

  const configWith = (values: Record<string, unknown>) =>
    ({
      get: <T>(key: string, fallback?: T) =>
        (values[key] as T) ?? (fallback as T),
    }) as unknown as ConfigService;

  /** A snapshot store with a baseline per code and a record of what was published. */
  const storeWith = (baselines: Record<string, string> = {}, missing: string[] = []) => {
    const published: Record<string, string> = {};
    const store = {
      lastAccepted: vi.fn(async (code: string) => {
        if (missing.includes(code)) throw new FxQuoteCurrencyMissing(code);
        return baselines[code] ? D(baselines[code]) : null;
      }),
      publish: vi.fn(async (code: string, rate: Prisma.Decimal) => {
        if (missing.includes(code)) throw new FxQuoteCurrencyMissing(code);
        published[code] = rate.toString();
        return {
          snapshot: {
            id: `snap-${code}`,
            snapshotId: `snap-${code}`,
            currencyCode: code,
            rate: rate.toString(),
            source: 'external_api',
            effectiveAt: '2026-09-28T10:00:00.000Z',
          },
          cached: true,
        };
      }),
    };
    return { store: store as unknown as FxRateSnapshotStore, published, spy: store };
  };

  const jobWith = (values: Record<string, unknown>, store: FxRateSnapshotStore) => {
    const config = configWith(values);
    return new FxRateJob(config, new FxRatePoller(config), store);
  };

  /** Irr at 2,450,000 rial per USDT from two books (one rial, one toman). */
  const irrAnswers = () => {
    bodies[url('nobitex')] = book('2449000', '2451000');
    bodies[url('tabdeal')] = book('244900', '245100');
  };

  const kraken = (bid: string, ask: string) => ({
    error: [],
    result: { USDTEUR: book(bid, ask) },
  });

  const tgju = (eurRial: string, tryRial: string) => ({
    current: { price_eur: { p: eurRial }, price_try: { p: tryRial } },
  });

  it('normalises a direct book, an inverted book and a rial quote to the same "per USD" rate', async () => {
    irrAnswers();
    bodies[url('kraken-eur')] = kraken('0.8796', '0.8798'); // EUR per USDT
    bodies[url('binance-eur')] = book('1.1368', '1.1369'); // USDT per EUR
    // 2,450,000 rial per USD / 2,784,090.9 rial per EUR = 0.88 EUR per USD
    bodies[url('tgju-eur')] = tgju('2,784,091', '50,000');
    const { store, published } = storeWith();

    const result = await jobWith(
      {
        FX_CURRENCIES: 'IRR,EUR',
        FX_SOURCES: 'nobitex,tabdeal',
        FX_SOURCES_EUR: 'kraken-eur,binance-eur,tgju-eur',
      },
      store,
    ).run();

    expect(published.IRR).toBe('2450000');
    const eur = result.metrics!.currencies as Record<string, Record<string, any>>;
    expect(eur.EUR.perSource['kraken-eur'].rate).toBe('0.8797');
    // 1 / 1.13685, not 1.13685
    expect(Number(eur.EUR.perSource['binance-eur'].rate)).toBeCloseTo(0.87962, 5);
    expect(Number(eur.EUR.perSource['tgju-eur'].rate)).toBeCloseTo(0.88, 6);
    // median of three: the middle one
    expect(published.EUR).toBe('0.8797');
    expect(eur.EUR.accepted).toBe(true);
    expect(result.itemsProcessed).toBe(2);
  });

  it('reads an Iranian toman quote of one euro as rial per USD over ten times it', async () => {
    irrAnswers();
    bodies[url('tgju-eur')] = tgju('2,784,091', '50,000');
    // 278,409.1 toman per EUR = 2,784,091 rial: the same 0.88 as tgju's rial
    bodies[url('abantether-eur')] = {
      data: [{ symbol: 'EUR', price_sell: '278400', price_buy: '278418.2' }],
    };
    const { store, published } = storeWith();

    const result = await jobWith(
      {
        FX_CURRENCIES: 'EUR,IRR',
        FX_SOURCES: 'nobitex,tabdeal',
        FX_SOURCES_EUR: 'tgju-eur,abantether-eur',
      },
      store,
    ).run();

    const m = result.metrics!.currencies as Record<string, Record<string, any>>;
    expect(Number(m.EUR.perSource['abantether-eur'].rate)).toBeCloseTo(0.88, 6);
    // IRR ran first although FX_CURRENCIES lists it second
    expect(Object.keys(published)).toEqual(['IRR', 'EUR']);
  });

  it('divides a rial quote by this tick\'s IRR only when the gate accepted it', async () => {
    // IRR moves 50% against its baseline: refused, so the tick has no USDT/IRT.
    irrAnswers();
    bodies[url('kraken-eur')] = kraken('0.8796', '0.8798');
    bodies[url('bitstamp-eur')] = book('0.8795', '0.8797');
    bodies[url('tgju-eur')] = tgju('2,784,091', '50,000');
    const { store, published } = storeWith({ IRR: '1600000' });

    const result = await jobWith(
      {
        FX_CURRENCIES: 'IRR,EUR',
        FX_SOURCES: 'nobitex,tabdeal',
        FX_SOURCES_EUR: 'kraken-eur,bitstamp-eur,tgju-eur',
      },
      store,
    ).run();

    const m = result.metrics!.currencies as Record<string, Record<string, any>>;
    expect(m.IRR.accepted).toBe(false);
    expect(m.IRR.rejectedDeviationPercent).toBeGreaterThan(5);
    expect(published.IRR).toBeUndefined();
    expect(m.EUR.perSource['tgju-eur'].failed).toMatch(/USDT\/IRT/);
    // the foreign books still carry EUR
    expect(published.EUR).toBe('0.8796');
    expect(result.itemsProcessed).toBe(1);
    expect(result.errorsCount).toBeGreaterThan(0);
  });

  it('keeps one currency\'s shortfall and a missing currency row to that currency', async () => {
    irrAnswers();
    bodies[url('binance-try')] = book('48.99', '49.01'); // only one TRY source answers
    bodies[url('kraken-eur')] = kraken('0.8796', '0.8798');
    bodies[url('bitstamp-eur')] = book('0.8795', '0.8797');
    const { store, published } = storeWith({}, ['EUR']);

    const result = await jobWith(
      {
        FX_CURRENCIES: 'IRR,EUR,TRY',
        FX_SOURCES: 'nobitex,tabdeal',
        FX_SOURCES_EUR: 'kraken-eur,bitstamp-eur',
        FX_SOURCES_TRY: 'binance-try,btcturk-try',
      },
      store,
    ).run();

    const m = result.metrics!.currencies as Record<string, Record<string, any>>;
    expect(Object.keys(published)).toEqual(['IRR']);
    expect(m.TRY.accepted).toBeUndefined();
    expect(m.TRY.failed).toMatch(/only 1 of 2/);
    expect(m.EUR.failed).toMatch(/no currency row with code "EUR"/);
    expect(result.metrics!.published).toEqual(['IRR']);
    expect(result.itemsProcessed).toBe(1);
  });

  it('returns a failed run with every currency\'s numbers when none published', async () => {
    bodies[url('nobitex')] = book('2449000', '2451000');
    const { store } = storeWith();

    const result = await jobWith(
      { FX_CURRENCIES: 'IRR', FX_SOURCES: 'nobitex,tabdeal' },
      store,
    ).run();

    expect(result.itemsProcessed).toBe(0);
    expect(result.errorsCount).toBeGreaterThan(0);
    const m = result.metrics!.currencies as Record<string, Record<string, any>>;
    expect(m.IRR.perSource.nobitex.rate).toBe('2450000');
    expect(m.IRR.perSource.tabdeal.failed).toMatch(/503/);
  });

  it('refuses a source listed under a currency it does not rate, and leaves the others running', async () => {
    irrAnswers();
    const { store, published } = storeWith();

    const result = await jobWith(
      {
        FX_CURRENCIES: 'IRR,EUR',
        FX_SOURCES: 'nobitex,tabdeal',
        FX_SOURCES_EUR: 'nobitex,kraken-eur',
      },
      store,
    ).run();

    const m = result.metrics!.currencies as Record<string, Record<string, any>>;
    expect(m.EUR.failed).toMatch(/'nobitex' rates IRR, not EUR/);
    expect(published.IRR).toBe('2450000');
  });

  it('declares, for every source this build knows, the currency it rates and how its book reads', () => {
    for (const s of FX_SOURCES) {
      expect(s.currency).toMatch(/^[A-Z]{3}$/);
      if (s.reads === 'toman-per-usdt') expect(s.currency).toBe('IRR');
    }
    expect(new Set(FX_SOURCES.map((s) => s.key)).size).toBe(FX_SOURCES.length);
  });
});
