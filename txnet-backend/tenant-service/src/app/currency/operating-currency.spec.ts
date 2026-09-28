import { Prisma } from '@prisma/client';
import { CurrencyChangeConflict, ResellerAccess, convertOperatingCurrency, readFxPair } from '@txnet-backend/shared-core';

import { setOperatingCurrencySchema } from './operating-currency.schema';
import { OperatingCurrencyRefused, TenantOperatingCurrencyService } from './operating-currency.service';

vi.mock('@txnet-backend/shared-core', async (original) => ({
  ...(await original<typeof import('@txnet-backend/shared-core')>()),
  readFxPair: vi.fn(),
  convertOperatingCurrency: vi.fn(),
}));

/**
 * The invariants F-116-a turns on (ADR-0098 parts 1, 6, 8).
 *
 * - Every tenant, the platform owner's included, has an operating currency;
 *   the column's default is `USD`.
 * - Only a currency with a rate may be chosen: active, at most two decimals
 *   (money columns are `DECIMAL(18,2)`), and either the USD pivot or holding an
 *   active rate row.
 * - A change converts the tenant's money at the rate old -> new, read once, in
 *   one transaction (F-116-f; what is converted is `currency-change.int.spec.ts`'s).
 *   No rate refuses it, and so does losing a race to another change.
 * - A reseller's is reached through `ResellerAccess`; the platform's only by
 *   its own staff holding `tenant.manage`.
 */
describe('TenantOperatingCurrencyService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };
  const stranger = { userId: STAFF, tenantId: PLATFORM, permissions: [] as string[] };
  const resellerAdmin = { userId: OWNER, tenantId: OTHER, permissions: ['tenant.manage'] };

  const CURRENCIES = [
    { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true, isBaseCurrency: true, exchangeRates: [] },
    { code: 'IRR', name: 'Iranian Rial', symbol: '﷼', decimalPlaces: 0, isActive: true, isBaseCurrency: false, exchangeRates: [{ id: 'r1' }] },
    { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, isActive: true, isBaseCurrency: false, exchangeRates: [] },
    // Tied to the rial (F-116-m): no row of its own, a rate while IRR has one.
    { code: 'IRT', name: 'Iranian Toman', symbol: 'تومان', decimalPlaces: 0, isActive: true, isBaseCurrency: false, exchangeRates: [] },
    { code: 'TRY', name: 'Lira', symbol: '₺', decimalPlaces: 2, isActive: false, isBaseCurrency: false, exchangeRates: [{ id: 'r2' }] },
    { code: 'KWD', name: 'Dinar', symbol: 'KD', decimalPlaces: 3, isActive: true, isBaseCurrency: false, exchangeRates: [{ id: 'r3' }] },
  ];

  const build = (opts: { status?: string } = {}) => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active', deletedAt: null, operatingCurrencyCode: 'USD' },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: opts.status ?? 'active', graceEndsAt: null, deletedAt: null, operatingCurrencyCode: 'USD' },
    };
    const appPrisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
    };
    const all: Record<string, unknown> = {
      tenant: { findUnique: appPrisma.tenant.findUnique },
      currency: { findMany: vi.fn(async () => CURRENCIES) },
    };
    all['$transaction'] = vi.fn(async (fn: (tx: unknown) => unknown) => fn(all));
    // The conversion itself runs against Postgres in currency-change.int.spec.ts; here it moves the label.
    vi.mocked(readFxPair).mockImplementation(async (_db, _cache, fromCode, toCode) => ({ fromCode, toCode, rate: new Prisma.Decimal(600000), from: null, to: null }));
    vi.mocked(convertOperatingCurrency).mockImplementation(async (_tx, input) => {
      tenants[input.tenantId].operatingCurrencyCode = input.toCode;
      return { changeId: 'c1', fromCode: input.pair.fromCode, toCode: input.toCode, rate: input.pair.rate.toString(), summary: {} as never };
    });
    const access = new ResellerAccess(appPrisma as never);
    const service = new TenantOperatingCurrencyService(access, all as never, { get: vi.fn(async () => null) } as never);
    return { service, all, tenants };
  };

  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof OperatingCurrencyRefused) return e.reason;
      throw e;
    }
    return 'accepted';
  };

  it('reads USD for a tenant that never chose, with only the currencies that have a rate as choices', async () => {
    const view = await build().service.read(owner, RESELLER);
    expect(view.code).toBe('USD');
    // EUR has no rate, TRY is inactive, KWD has three decimals.
    expect(view.choices.map((c) => c.code)).toEqual(['IRR', 'IRT', 'USD']);
  });

  it("lets the reseller's owner and the platform's staff change it, converting at the rate from the old currency to the new", async () => {
    const { service, tenants } = build();
    const changed = await service.set(owner, RESELLER, 'IRR', '10.0.0.1');
    expect([changed.code, changed.conversion?.fromCode, changed.conversion?.rate]).toEqual(['IRR', 'USD', '600000']);
    expect(tenants[RESELLER].operatingCurrencyCode).toBe('IRR');
    expect(vi.mocked(readFxPair).mock.calls.at(-1)?.slice(2, 4)).toEqual(['USD', 'IRR']);
    expect((await service.set(staff, RESELLER, 'USD', '10.0.0.1')).code).toBe('USD');
    expect(vi.mocked(readFxPair).mock.calls.at(-1)?.slice(2, 4)).toEqual(['IRR', 'USD']);
  });

  it('refuses a currency with no rate, an inactive one, one with three decimals and an unknown code', async () => {
    const { service, all } = build();
    for (const code of ['EUR', 'TRY', 'KWD', 'XYZ']) expect(await refusal(service.set(owner, RESELLER, code, '10.0.0.1'))).toBe('currency_unavailable');
    expect(all['$transaction']).not.toHaveBeenCalled();
  });

  it('a set to the currency it already has is not a change: no rate is read and nothing is written', async () => {
    const { service, all } = build();
    vi.mocked(readFxPair).mockClear();
    const same = await service.set(owner, RESELLER, 'USD', '10.0.0.1');
    expect([same.code, same.conversion]).toEqual(['USD', null]);
    expect(readFxPair).not.toHaveBeenCalled();
    expect(all['$transaction']).not.toHaveBeenCalled();
  });

  it('refuses a change with no rate for the pair, and converts nothing', async () => {
    const { service, all, tenants } = build();
    vi.mocked(readFxPair).mockResolvedValueOnce(null);
    expect(await refusal(service.set(owner, RESELLER, 'IRR', '10.0.0.1'))).toBe('rate_unavailable');
    expect(all['$transaction']).not.toHaveBeenCalled();
    expect(tenants[RESELLER].operatingCurrencyCode).toBe('USD');
  });

  it('refuses a change that lost a race to another, rather than converting at a rate read for the wrong currency', async () => {
    const { service } = build();
    vi.mocked(convertOperatingCurrency).mockRejectedValueOnce(new CurrencyChangeConflict(RESELLER, 'EUR', 'USD'));
    expect(await refusal(service.set(owner, RESELLER, 'IRR', '10.0.0.1'))).toBe('currency_changed');
  });

  it("lets the platform's own staff set the platform's currency, and nobody else", async () => {
    const { service } = build();
    expect((await service.set(staff, PLATFORM, 'IRR', '10.0.0.1')).code).toBe('IRR');
    expect(await refusal(service.read(stranger, PLATFORM))).toBe('not_allowed');
    expect(await refusal(service.read(owner, PLATFORM))).toBe('not_allowed');
    // tenant.manage in a reseller is not the platform's.
    expect(await refusal(service.set(resellerAdmin, PLATFORM, 'IRR', '10.0.0.1'))).toBe('not_allowed');
  });

  it('refuses a stranger, and a suspended reseller\'s owner writing', async () => {
    expect(await refusal(build().service.read(stranger, RESELLER))).toBe('not_allowed');
    const { service } = build({ status: 'suspended' });
    expect((await service.read(owner, RESELLER)).code).toBe('USD');
    expect(await refusal(service.set(owner, RESELLER, 'IRR', '10.0.0.1'))).toBe('reseller_suspended');
  });

  it('takes a three-letter upper-case code and nothing else', () => {
    expect(setOperatingCurrencySchema.safeParse({ code: 'IRR' }).success).toBe(true);
    for (const body of [{ code: 'irr' }, { code: 'IRRX' }, { code: '' }, {}, { code: 'IRR', extra: 1 }]) {
      expect(setOperatingCurrencySchema.safeParse(body).success).toBe(false);
    }
  });
});
