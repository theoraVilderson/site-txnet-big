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
 * - So is a set while it holds a money-bearing setting (F-116-a2): a gateway
 *   with a limit, a fixed fee, a fee floor/ceiling or presets; a live coupon
 *   with an amount in it; a fixed-amount rule; deposit presets. A setting
 *   with no amount in it (a percentage, an empty list) does not count.
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

  /** The settings whose `findFirst` answers by its `where` (F-116-a2). */
  type Setting = 'tenantGatewayConfig' | 'paymentGateway' | 'coupon' | 'discountRule' | 'depositSetting';
  type Row = Record<string, unknown>;

  /** Just enough of Prisma's `where` for the probes: equality, `not`, `in`, `isEmpty`, `OR`, `AND`. */
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
      if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
      const value = row[key] ?? null;
      if (cond === null || typeof cond !== 'object') return value === cond;
      const c = cond as { not?: unknown; in?: unknown[]; isEmpty?: boolean };
      if ('not' in c) return c.not === null ? value !== null : value === null || Number(value) !== Number(c.not);
      if (c.in) return c.in.includes(value);
      return (((value as unknown[] | null) ?? []).length === 0) === c.isEmpty;
    });

  const build = (opts: { status?: string; money?: Money[]; settings?: Partial<Record<Setting, Row[]>> } = {}) => {
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
    const setting = (table: Setting) => ({
      findFirst: vi.fn(async ({ where }: { where: Row }) => (opts.settings?.[table] ?? []).find((r) => matches(r, where)) ?? null),
    });
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
      tenantGatewayConfig: setting('tenantGatewayConfig'),
      paymentGateway: setting('paymentGateway'),
      coupon: setting('coupon'),
      discountRule: setting('discountRule'),
      depositSetting: setting('depositSetting'),
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

  const gateway = { tenantId: RESELLER, feeType: 'percentage', feeValue: 1.5, depositPresets: [] };
  const coupon = { tenantId: RESELLER, discountType: 'percentage', deletedAt: null };

  it.each<[string, Setting, Row]>([
    ['a gateway with a minimum', 'tenantGatewayConfig', { ...gateway, minAcceptAmount: 10 }],
    ['a gateway with a maximum', 'tenantGatewayConfig', { ...gateway, maxAcceptAmount: 500 }],
    ['a gateway with a fee floor', 'tenantGatewayConfig', { ...gateway, feeFloor: 1 }],
    ['a gateway with a fee ceiling', 'tenantGatewayConfig', { ...gateway, feeCeiling: 20 }],
    ['a gateway with presets', 'tenantGatewayConfig', { ...gateway, depositPresets: [10, 50] }],
    ['a gateway with a fixed fee', 'tenantGatewayConfig', { ...gateway, feeType: 'fixed', feeValue: 2 }],
    ['a fixed-amount coupon', 'coupon', { ...coupon, discountType: 'fixed_amount' }],
    ['a gift code', 'coupon', { ...coupon, discountType: 'wallet_credit' }],
    ['a percentage coupon with a cap', 'coupon', { ...coupon, maxDiscountCap: 5 }],
    ['a coupon with a minimum purchase', 'coupon', { ...coupon, minPurchaseAmount: 10 }],
    ['a coupon with a maximum purchase', 'coupon', { ...coupon, maxPurchaseAmount: 100 }],
    ['a fixed-amount rule', 'discountRule', { tenantId: RESELLER, kind: 'fixed_amount' }],
    ['deposit presets', 'depositSetting', { tenantId: RESELLER, presets: [5, 10] }],
  ])('refuses a set while the reseller holds %s, and says so on read', async (_, table, row) => {
    const { service, all } = build({ settings: { [table]: [row] } });
    expect((await service.read(owner, RESELLER)).changeable).toBe(false);
    expect(await refusal(service.set(owner, RESELLER, 'IRR'))).toBe('tenant_has_money');
    expect(all.tenant.update).not.toHaveBeenCalled();
  });

  it('does not count a setting with no amount in it, a deleted coupon, or another tenant\'s or the platform\'s', async () => {
    const { service } = build({
      settings: {
        tenantGatewayConfig: [gateway, { ...gateway, feeType: 'fixed', feeValue: 0 }, { ...gateway, tenantId: OTHER, minAcceptAmount: 1 }],
        paymentGateway: [{ ...gateway, minAcceptAmount: 1 }],
        coupon: [
          coupon,
          { ...coupon, discountType: 'free_grant' },
          { ...coupon, discountType: 'fixed_amount', deletedAt: new Date() },
          { ...coupon, tenantId: OTHER, discountType: 'fixed_amount' },
          { ...coupon, tenantId: null, discountType: 'fixed_amount' },
        ],
        discountRule: [{ tenantId: RESELLER, kind: 'percentage' }],
        depositSetting: [{ tenantId: RESELLER, presets: [] }],
      },
    });
    expect((await service.set(owner, RESELLER, 'IRR')).code).toBe('IRR');
  });

  it("counts the platform's own gateways and platform-wide coupons against the platform's currency", async () => {
    for (const settings of [
      { paymentGateway: [{ ...gateway, feeCeiling: 3 }] },
      { coupon: [{ ...coupon, tenantId: null, discountType: 'fixed_amount' }] },
      { discountRule: [{ tenantId: PLATFORM, kind: 'fixed_amount' }] },
    ]) {
      const { service } = build({ settings });
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
