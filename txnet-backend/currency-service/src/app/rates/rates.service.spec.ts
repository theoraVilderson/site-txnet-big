import { Prisma } from '@prisma/client';

import { CurrencyRatesService } from './rates.service';

/**
 * F-116-k — the first read `currency-service` serves: every active currency,
 * with the rate it has now. Two rules:
 *
 * 1. **The rate is shared-core's `readFxRate`**, the one reader every service
 *    uses (currency/contract.md) — cache first, the newest row second — so this
 *    route can never disagree with what billing prices at.
 * 2. **A currency without a rate is listed with `rate: null`**, not left out:
 *    the manual-rate form (F-0608-a) exists for exactly that currency. The base
 *    currency is `1`, with no read.
 */
describe('CurrencyRatesService (F-116-k)', () => {
  const at = new Date('2026-09-28T16:45:00Z');

  const service = (cache: Record<string, string>, rows: Record<string, { id: string; rate: string }>) => {
    const currencies = [
      { id: 'c-usd', code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isBaseCurrency: true },
      { id: 'c-eur', code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, isBaseCurrency: false },
      { id: 'c-gbp', code: 'GBP', name: 'British Pound', symbol: '£', decimalPlaces: 2, isBaseCurrency: false },
      { id: 'c-irr', code: 'IRR', name: 'Iranian Rial', symbol: '﷼', decimalPlaces: 0, isBaseCurrency: false },
    ];
    const findMany = vi.fn(async () => currencies);
    const db = {
      currency: {
        findMany,
        findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
          currencies.find((c) => c.code === where.code) ?? null,
        ),
      },
      currencyExchangeRate: {
        findFirst: vi.fn(async ({ where }: { where: { currencyId: string } }) => {
          const code = currencies.find((c) => c.id === where.currencyId)!.code;
          const row = rows[code];
          return row ? { id: row.id, rate: new Prisma.Decimal(row.rate), effectiveAt: at } : null;
        }),
      },
    };
    const redis = { get: vi.fn(async (key: string) => cache[key.replace(/^.*fx:rate:/, '')] ?? null) };
    return { rates: new CurrencyRatesService(db as never, redis as never), findMany, redis };
  };

  it('lists every active currency with the rate readFxRate gives it, cache first, table second', async () => {
    const { rates, findMany } = service(
      {
        EUR: JSON.stringify({ snapshotId: 's-eur', currencyCode: 'EUR', rate: '0.87885046', source: 'external_api', effectiveAt: at.toISOString() }),
      },
      { IRR: { id: 's-irr', rate: '2438995' } },
    );

    const list = await rates.list('t-1');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true } }));
    expect(list.map((r) => r.code)).toEqual(['EUR', 'GBP', 'IRR', 'USD']);
    const byCode = Object.fromEntries(list.map((r) => [r.code, r]));
    expect(byCode.EUR).toMatchObject({ rate: '0.87885046', snapshotId: 's-eur', effectiveAt: at.toISOString() });
    expect(byCode.IRR).toMatchObject({ rate: '2438995', snapshotId: 's-irr' });
    expect(byCode.GBP).toMatchObject({ rate: null, snapshotId: null, effectiveAt: null });
    expect(byCode.USD).toMatchObject({ rate: '1', snapshotId: null, isBase: true });
  });
});
