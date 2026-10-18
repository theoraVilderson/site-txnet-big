import { createPackageSchema, type CreatePackageInput } from './tenant-package.schema';
import { TenantPackageService } from './tenant-package.service';
import { currencyRegistry } from '../../../../test-support/currency-registry';

/**
 * A package is created whole, or not at all (ADR-0154 decision 4, PK-1-a).
 *
 * `POST /tenant-packages` may carry the package's limits, its overage modes
 * and the platform products it sells, and they are written in the package's
 * own transaction: a part that is refused leaves no package behind that sells
 * nothing. Each part is checked as its own endpoint checks it
 * (contract.limits.md), and a refusal names the field, so the wizard can go
 * back to that step. The body without them stays what it was.
 */
describe('TenantPackageService — create, the whole package in one transaction', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const PKG = '33333333-3333-3333-3333-333333333333';
  const PLATFORM_PRODUCT = '44444444-4444-4444-8444-444444444444';
  const RESELLERS_PRODUCT = '55555555-5555-4555-8555-555555555555';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  const base: CreatePackageInput = { name: 'Gold', monthlyPrice: '10.00', includedFeatureKeys: ['spin_wheel'] };
  const whole: CreatePackageInput = {
    ...base,
    limits: [
      { key: 'staff_members_max', value: 5 },
      { key: 'end_users_max', value: null },
    ],
    quotaOverages: [{ key: 'campaign_sends_daily_max', mode: 'overage', unitPrice: '0.50' }],
    products: [{ productId: PLATFORM_PRODUCT, month: 100, overage: { mode: 'overage', unitPrice: '1.25' } }],
  };

  /** A transaction whose writes land only when its callback resolves — as Postgres's do. */
  const build = (platformCurrency = 'USD') => {
    const committed: string[] = [];
    let staged: string[] = [];
    const write = (what: string) => staged.push(what);
    const tx = {
      ...currencyRegistry,
      $queryRaw: vi.fn(async () => []),
      tenant: {
        findFirst: vi.fn(async () => ({ id: OWNER_TENANT, operatingCurrencyCode: platformCurrency })),
      },
      tenantFeaturePackage: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          write('package');
          return { id: PKG, monthlyPrice: { toString: () => '10' }, yearlyPrice: null, isActive: true, ...data, name: data['name'] };
        }),
      },
      packageLimit: { createMany: vi.fn(async ({ data }: { data: unknown[] }) => (write(`limits:${data.length}`), { count: data.length })) },
      packageQuotaOverage: { createMany: vi.fn(async ({ data }: { data: unknown[] }) => (write(`overages:${data.length}`), { count: data.length })) },
      packageProduct: { createMany: vi.fn(async ({ data }: { data: unknown[] }) => (write(`products:${data.length}`), { count: data.length })) },
      product: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; tenantId: string } }) =>
          where.id.in.filter((id) => id === PLATFORM_PRODUCT && where.tenantId === OWNER_TENANT).map((id) => ({ id })),
        ),
      },
      adminAuditLog: { create: vi.fn(async () => (write('audit'), {})) },
      tenantPackageMeterRate: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      tenant: { findUnique: vi.fn(async () => ({ tenantType: 'platform_owner' })) },
      tenantFeaturePackage: { findUnique: vi.fn(async () => null) },
    };
    const all = {
      ...prisma,
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => {
        staged = [];
        const result = await fn(tx);
        committed.push(...staged);
        return result;
      }),
    };
    return { service: new TenantPackageService(prisma as never, all as never), tx, all, committed };
  };

  it('writes the package, its limits, overage modes and products in one transaction, and audits all of it', async () => {
    const { service, all, tx, committed } = build();
    await service.create(actor, whole);

    expect(all.$transaction).toHaveBeenCalledTimes(1);
    expect(committed).toEqual(['package', 'limits:2', 'overages:1', 'products:1', 'audit']);
    expect((tx.packageLimit.createMany.mock.calls[0] as unknown as [{ data: unknown[] }])[0].data).toEqual([
      { packageId: PKG, key: 'staff_members_max', value: 5, updatedByUserId: ADMIN },
      { packageId: PKG, key: 'end_users_max', value: null, updatedByUserId: ADMIN },
    ]);
    const [overage] = (tx.packageQuotaOverage.createMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>[] }])[0].data;
    expect(overage).toMatchObject({ packageId: PKG, key: 'campaign_sends_daily_max', mode: 'overage', currencyCode: 'USD' });
    expect(String(overage['unitPrice'])).toBe('0.5');
    const [listed] = (tx.packageProduct.createMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>[] }])[0].data;
    expect(listed).toMatchObject({ packageId: PKG, productId: PLATFORM_PRODUCT, dayIncluded: null, weekIncluded: null, monthIncluded: 100, mode: 'overage', currencyCode: 'USD' });
    const audit = (tx.adminAuditLog.create.mock.calls[0] as unknown as [{ data: { newValue: Record<string, unknown> } }])[0].data.newValue;
    expect(audit).toMatchObject({ limits: whole.limits, quotaOverages: whole.quotaOverages, products: whole.products });
  });

  it('keeps the old body: no parts, no part rows', async () => {
    const { service, committed } = build();
    await service.create(actor, base);
    expect(committed).toEqual(['package', 'audit']);
  });

  it.each([
    ['a key the registry does not have', { limits: [{ key: 'no_such_limit', value: 1 }] }, 'unknown_limit', 'limits.0.key'],
    ['a value past the key’s bound', { limits: [{ key: 'staff_members_max', value: 1_000_001 }] }, 'limit_out_of_range', 'limits.0.value'],
    ['an overage on a guard', { quotaOverages: [{ key: 'staff_members_max', mode: 'stop' as const }] }, 'not_a_quota', 'quotaOverages.0.key'],
    ['a product that is not the platform’s', { products: [{ productId: RESELLERS_PRODUCT }] }, 'product_not_found', 'products.0.productId'],
  ])('refuses %s, names the field, and writes nothing — not even the package', async (_, part, reason, field) => {
    const { service, committed } = build();
    await expect(service.create(actor, { ...whole, ...part } as CreatePackageInput)).rejects.toMatchObject({ reason, field });
    expect(committed).toEqual([]);
  });

  it("refuses a product's overage price finer than the platform currency's places, naming it (F-019-v6-a)", async () => {
    const { service, committed } = build('IRT');
    const finer = { ...whole, quotaOverages: [], products: [{ productId: PLATFORM_PRODUCT, overage: { mode: 'overage' as const, unitPrice: '1.25' } }] };
    await expect(service.create(actor, finer)).rejects.toMatchObject({ reason: 'amount_finer_than_currency', field: 'products.0.overage.unitPrice' });
    expect(committed).toEqual([]);
  });

  it('a failure after the package row rolls the package back with it', async () => {
    const { service, tx, committed } = build();
    tx.packageProduct.createMany.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.create(actor, whole)).rejects.toThrow('connection reset');
    expect(committed).toEqual([]);
  });

  it('refuses a repeated key or product, naming the list', () => {
    const twice = createPackageSchema.safeParse({
      ...base,
      limits: [
        { key: 'staff_members_max', value: 1 },
        { key: 'staff_members_max', value: 2 },
      ],
      products: [{ productId: PLATFORM_PRODUCT }, { productId: PLATFORM_PRODUCT }],
    });
    expect(twice.success).toBe(false);
    expect(twice.error?.issues.map((i) => i.path.join('.')).sort()).toEqual(['limits', 'products']);
  });
});
