import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Mock } from 'vitest';
import { validateEnv } from '../config/env.validation';
import { FX_CURRENCY_DEFAULTS, fxCurrencyConfig } from './fx-currencies';
import { answered, FxRatePoller } from './fx-rate.poller';
import { FX_SOURCES, fxSourcesFor } from './fx-source';

/**
 * F-116-i2 — rates for the well-known currencies, from sources that quote many
 * currencies in one answer (tgju's market table, the ECB's and the Turkish
 * central bank's daily reference rates).
 *
 * 1. **One fetch per source per tick.** Twenty currencies read from tgju are
 *    one download of tgju, not twenty — the same answer is parsed per currency.
 * 2. **A per-unit count is part of the quote.** tgju and TCMB price the yen
 *    per 100; read as per 1, it is a rate a hundred times wrong.
 * 3. **A central bank's cross is computed inside its own table**: ECB's
 *    X-per-EUR over its USD-per-EUR, TCMB's TRY-per-USD over its TRY-per-X.
 * 4. **An official rate that stopped updating does not vote.** A reference
 *    rate older than four days (a weekend and a holiday) is a failure.
 * 5. **Every default currency has at least two sources** — the median's
 *    minimum — and every source rates a currency the table knows.
 */
describe('FX sources for many currencies (F-116-i2)', () => {
  const D = (v: string) => new Prisma.Decimal(v);
  const TODAY = '2026-09-28';

  let fetchMock: Mock;
  let bodies: Record<string, unknown>;

  const configWith = (values: Record<string, unknown> = {}) =>
    ({
      get: <T>(key: string, fallback?: T) => (values[key] as T) ?? (fallback as T),
    }) as unknown as ConfigService;

  const urlOf = (key: string) => FX_SOURCES.find((s) => s.key === key)!.url;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    bodies = {};
    fetchMock = vi.fn(async (u: string) => {
      if (!(u in bodies)) return { ok: false, status: 503 } as Response;
      const b = bodies[u];
      return {
        ok: true,
        status: 200,
        json: async () => b,
        text: async () => (typeof b === 'string' ? b : JSON.stringify(b)),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const ecbXml = (date: string) => `<?xml version="1.0"?><gesmes:Envelope><Cube>
    <Cube time='${date}'>
      <Cube currency='USD' rate='1.1378'/>
      <Cube currency='JPY' rate='178.50'/>
      <Cube currency='GBP' rate='0.85785'/>
    </Cube></Cube></gesmes:Envelope>`;

  const tcmbXml = (date: string) => `<?xml version="1.0"?>
    <Tarih_Date Tarih="${date}" Date="09/28/2026">
    <Currency Kod="USD" CurrencyCode="USD"><Unit>1</Unit>
      <ForexBuying>48.90</ForexBuying><ForexSelling>49.00</ForexSelling></Currency>
    <Currency Kod="JPY" CurrencyCode="JPY"><Unit>100</Unit>
      <ForexBuying>31.10</ForexBuying><ForexSelling>31.30</ForexSelling></Currency>
    </Tarih_Date>`;

  it('downloads a many-currency source once per tick, however many currencies read it', async () => {
    bodies[urlOf('tgju-gbp')] = {
      current: { price_gbp: { p: '3,250,000' }, price_jpy: { p: '1,560,000' }, price_eur: { p: '2,790,000' } },
    };
    const poller = new FxRatePoller(configWith());
    const fetches = new Map();
    const irr = D('2450000');

    const all = await Promise.all(
      ['GBP', 'JPY', 'EUR'].map((c) =>
        poller.poll(fxSourcesFor(c, [`tgju-${c.toLowerCase()}`]), irr, fetches),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(all.flat().every(answered)).toBe(true);
  });

  it('reads tgju\'s yen per 100, and the pound per 1', async () => {
    bodies[urlOf('tgju-jpy')] = {
      current: { price_gbp: { p: '3,250,000' }, price_jpy: { p: '1,560,000' } },
    };
    const poller = new FxRatePoller(configWith());
    const irr = D('2450000');

    const [jpy] = await poller.poll(fxSourcesFor('JPY', ['tgju-jpy']), irr);
    const [gbp] = await poller.poll(fxSourcesFor('GBP', ['tgju-gbp']), irr);

    if (!answered(jpy) || !answered(gbp)) throw new Error('unreachable');
    // 2,450,000 / (1,560,000 / 100) = 157.05 yen per USD, not 1.57
    expect(jpy.rate.toFixed(2)).toBe('157.05');
    // 2,450,000 / 3,250,000
    expect(gbp.rate.toFixed(4)).toBe('0.7538');
  });

  it('computes the ECB\'s and TCMB\'s crosses inside their own tables', async () => {
    bodies[urlOf('ecb-jpy')] = ecbXml(TODAY);
    bodies[urlOf('tcmb-jpy')] = tcmbXml('28.09.2026');
    const poller = new FxRatePoller(configWith());

    const [ecbJpy, ecbGbp, ecbEur] = await poller.poll(
      [...fxSourcesFor('JPY', ['ecb-jpy']), ...fxSourcesFor('GBP', ['ecb-gbp']), ...fxSourcesFor('EUR', ['ecb-eur'])],
      null,
    );
    const [tcmbJpy, tcmbTry] = await poller.poll(
      [...fxSourcesFor('JPY', ['tcmb-jpy']), ...fxSourcesFor('TRY', ['tcmb-try'])],
      null,
    );

    for (const o of [ecbJpy, ecbGbp, ecbEur, tcmbJpy, tcmbTry])
      if (!answered(o)) throw new Error(`${o.source}: ${o.reason}`);
    const rate = (o: typeof ecbJpy) => (answered(o) ? o.rate : D('0'));
    expect(rate(ecbJpy).toFixed(2)).toBe('156.88'); // 178.50 / 1.1378
    expect(rate(ecbGbp).toFixed(4)).toBe('0.7540'); // 0.85785 / 1.1378
    expect(rate(ecbEur).toFixed(4)).toBe('0.8789'); // 1 / 1.1378
    expect(rate(tcmbTry).toFixed(2)).toBe('48.95'); // mid of 48.90 / 49.00
    expect(rate(tcmbJpy).toFixed(2)).toBe('156.89'); // 48.95 / (31.20 / 100)
  });

  it('refuses an official rate more than four days old', async () => {
    bodies[urlOf('ecb-gbp')] = ecbXml('2026-09-21');
    bodies[urlOf('tcmb-jpy')] = tcmbXml('21.09.2026');
    const poller = new FxRatePoller(configWith());

    const [ecb, tcmb] = await poller.poll(
      [...fxSourcesFor('GBP', ['ecb-gbp']), ...fxSourcesFor('JPY', ['tcmb-jpy'])],
      null,
    );

    expect(answered(ecb)).toBe(false);
    expect(answered(tcmb)).toBe(false);
    if (!answered(ecb)) expect(ecb.reason).toMatch(/2026-09-21.*older than 4 days/);
  });

  it('gives every default currency at least two sources, a band, and only its own sources', () => {
    const codes = Object.keys(FX_CURRENCY_DEFAULTS);
    expect(codes.length).toBeGreaterThanOrEqual(23);
    for (const code of codes) {
      const c = fxCurrencyConfig(configWith(), code);
      expect(c.sources.length, code).toBeGreaterThanOrEqual(2);
      expect(c.sanityMin.lt(c.sanityMax), code).toBe(true);
    }
    for (const s of FX_SOURCES) expect(codes, s.key).toContain(s.currency);
  });

  it('carries a per-currency override through env validation, and drops an empty one', () => {
    const env = validateEnv({
      DATABASE_APP_URL: 'postgresql://x',
      RABBITMQ_URL: 'amqp://x',
      REDIS_URL: 'redis://x',
      FX_SOURCES_GBP: 'tgju-gbp,ecb-gbp',
      FX_SANITY_MIN_GBP: '0.5',
      FX_SOURCES_EUR: '',
      FX_SOURCES_gbp: 'ignored',
    } as Record<string, unknown>) as unknown as Record<string, unknown>;

    expect(env.FX_SOURCES_GBP).toBe('tgju-gbp,ecb-gbp');
    expect(env.FX_SANITY_MIN_GBP).toBe('0.5');
    expect(env).not.toHaveProperty('FX_SOURCES_EUR');
    expect(env).not.toHaveProperty('FX_SOURCES_gbp');
  });
});
