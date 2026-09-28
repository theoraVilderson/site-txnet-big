import { ResellerAccess } from '@txnet-backend/shared-core';

import { setOperatingCurrencySchema } from './operating-currency.schema';
import { OperatingCurrencyRefused, TenantOperatingCurrencyService } from './operating-currency.service';

/**
 * The invariants F-116-a turns on (ADR-0098 parts 1, 6, 8).
 *
 * - Every tenant, the platform owner's included, has an operating currency;
 *   the column's default is `USD`.
 * - Only a currency with a rate may be chosen: active, at most two decimals
 *   (money columns are `DECIMAL(18,2)`), and either the USD pivot or holding an
 *   active rate row.
 * - A set is refused while the tenant has money — a ledger row, an invoice, a
 *   payment, a price; for the platform, also any tenant ↔ platform money —
 *   until F-116-f converts it.
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
    { code: 'TRY', name: 'Lira', symbol: '₺', decimalPlaces: 2, isActive: false, isBaseCurrency: false, exchangeRates: [{ id: 'r2' }] },
    { code: 'KWD', name: 'Dinar', symbol: 'KD', decimalPlaces: 3, isActive: true, isBaseCurrency: false, exchangeRates: [{ id: 'r3' }] },
  ];

  type Money = 'walletTransaction' | 'invoice' | 'paymentTransaction' | 'price' | 'meteredRate' | 'tenantBillingTransaction' | 'tenantFeaturePackage';

  const build = (opts: { status?: string; money?: Money[] } = {}) => {
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
    const probe = (table: Money) => ({ findFirst: vi.fn(async () => (opts.money?.includes(table) ? { id: 'x' } : null)) });
    const all = {
      tenant: {
        findUnique: appPrisma.tenant.findUnique,
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(tenants[where.id], data)),
      },
      currency: { findMany: vi.fn(async () => CURRENCIES) },
      walletTransaction: probe('walletTransaction'),
      invoice: probe('invoice'),
      paymentTransaction: probe('paymentTransaction'),
      price: probe('price'),
      meteredRate: probe('meteredRate'),
      tenantBillingTransaction: probe('tenantBillingTransaction'),
      tenantFeaturePackage: probe('tenantFeaturePackage'),
    };
    const access = new ResellerAccess(appPrisma as never);
    const service = new TenantOperatingCurrencyService(access, all as never);
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
    const { service } = build();
    const view = await service.read(owner, RESELLER);
    expect(view.code).toBe('USD');
    expect(view.changeable).toBe(true);
    // EUR has no rate, TRY is inactive, KWD has three decimals.
    expect(view.choices.map((c) => c.code)).toEqual(['IRR', 'USD']);
  });

  it("lets the reseller's owner and the platform's staff set it", async () => {
    const { service, tenants } = build();
    expect((await service.set(owner, RESELLER, 'IRR')).code).toBe('IRR');
    expect(tenants[RESELLER].operatingCurrencyCode).toBe('IRR');
    expect((await service.set(staff, RESELLER, 'USD')).code).toBe('USD');
  });

  it('refuses a currency with no rate, an inactive one, one with three decimals and an unknown code', async () => {
    const { service, all } = build();
    for (const code of ['EUR', 'TRY', 'KWD', 'XYZ']) expect(await refusal(service.set(owner, RESELLER, code))).toBe('currency_unavailable');
    expect(all.tenant.update).not.toHaveBeenCalled();
  });

  it.each<Money>(['walletTransaction', 'invoice', 'paymentTransaction', 'price', 'meteredRate'])(
    'refuses a set while the reseller has money (%s), and says so on read',
    async (table) => {
      const { service, all } = build({ money: [table] });
      expect((await service.read(owner, RESELLER)).changeable).toBe(false);
      expect(await refusal(service.set(owner, RESELLER, 'IRR'))).toBe('tenant_has_money');
      expect(all.tenant.update).not.toHaveBeenCalled();
    },
  );

  it('a set to the currency it already has is not a change, so money does not refuse it', async () => {
    const { service, all } = build({ money: ['invoice'] });
    expect((await service.set(owner, RESELLER, 'USD')).code).toBe('USD');
    expect(all.tenant.update).not.toHaveBeenCalled();
  });

  it("does not count tenant ↔ platform money against a reseller — that is in the platform's currency", async () => {
    const { service } = build({ money: ['tenantBillingTransaction', 'tenantFeaturePackage'] });
    expect((await service.set(owner, RESELLER, 'IRR')).code).toBe('IRR');
  });

  it("counts tenant ↔ platform money against the platform's own currency", async () => {
    for (const table of ['tenantBillingTransaction', 'tenantFeaturePackage'] as Money[]) {
      const { service } = build({ money: [table] });
      expect(await refusal(service.set(staff, PLATFORM, 'IRR'))).toBe('tenant_has_money');
    }
  });

  it("lets the platform's own staff set the platform's currency, and nobody else", async () => {
    const { service } = build();
    expect((await service.set(staff, PLATFORM, 'IRR')).code).toBe('IRR');
    expect(await refusal(service.read(stranger, PLATFORM))).toBe('not_allowed');
    expect(await refusal(service.read(owner, PLATFORM))).toBe('not_allowed');
    // tenant.manage in a reseller is not the platform's.
    expect(await refusal(service.set(resellerAdmin, PLATFORM, 'IRR'))).toBe('not_allowed');
  });

  it('refuses a stranger, and a suspended reseller\'s owner writing', async () => {
    expect(await refusal(build().service.read(stranger, RESELLER))).toBe('not_allowed');
    const { service } = build({ status: 'suspended' });
    expect((await service.read(owner, RESELLER)).code).toBe('USD');
    expect(await refusal(service.set(owner, RESELLER, 'IRR'))).toBe('reseller_suspended');
  });

  it('takes a three-letter upper-case code and nothing else', () => {
    expect(setOperatingCurrencySchema.safeParse({ code: 'IRR' }).success).toBe(true);
    for (const body of [{ code: 'irr' }, { code: 'IRRX' }, { code: '' }, {}, { code: 'IRR', extra: 1 }]) {
      expect(setOperatingCurrencySchema.safeParse(body).success).toBe(false);
    }
  });
});
