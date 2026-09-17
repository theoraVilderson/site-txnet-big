import { TenantPackageRefused, TenantPackageService } from './tenant-package.service';
import { type CreatePackageInput, createPackageSchema, updatePackageSchema } from './tenant-package.schema';

/**
 * The invariants F-018-d turns on, at the one surface that writes a package.
 *
 * - Only the platform owner writes or reads packages, refused before any
 *   package row is touched.
 * - A price is a base-currency decimal string, positive, two places (C-02);
 *   a package always has at least one of its two prices.
 * - A package is never deleted: it is deactivated, and deactivation writes
 *   nothing but `isActive` — its subscribers stay until renewal.
 * - Every write is audited with the before and after.
 */
describe('TenantPackageService', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const PKG = '33333333-3333-3333-3333-333333333333';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  const input: CreatePackageInput = { name: 'Growth', monthlyPrice: '1500000.00', yearlyPrice: '15000000', includedFeatureKeys: ['spin_wheel', 'coupon_engine'] };

  const stored = (over: Record<string, unknown> = {}) => ({
    id: PKG,
    name: 'Growth',
    monthlyPrice: { toString: () => '1500000' },
    yearlyPrice: null,
    includedFeatureKeys: ['spin_wheel'],
    isActive: true,
    ...over,
  });

  const build = (opts: { callerType?: string; existing?: ReturnType<typeof stored> | null; nameTaken?: boolean; subscribersOnPeriod?: number } = {}) => {
    const writes: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      tenantFeaturePackage: {
        findUnique: vi.fn(async () => opts.existing ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('create'), stored({ ...data, id: PKG }))),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('update'), stored({ ...opts.existing, ...data }))),
      },
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
      tenantSubscription: { count: vi.fn(async () => opts.subscribersOnPeriod ?? 0) },
    };
    const prisma = {
      tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) },
      tenantFeaturePackage: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string; name?: string } }) =>
          where.name !== undefined ? (opts.nameTaken ? { id: 'other' } : null) : (opts.existing ?? null),
        ),
        findMany: vi.fn(async () => [stored()]),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { service: new TenantPackageService(prisma as never, prisma as never), prisma, tx, writes };
  };

  it('refuses a caller who is not the platform owner before a package is touched', async () => {
    const { service, prisma } = build({ callerType: 'reseller' });
    await expect(service.create(actor, input)).rejects.toMatchObject({ reason: 'not_platform_owner' });
    await expect(service.list(actor, {})).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(prisma.tenantFeaturePackage.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenantFeaturePackage.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates the package and its audit row in one transaction, prices as decimal strings', async () => {
    const { service, prisma, tx, writes } = build();
    const view = await service.create(actor, input);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(['create', 'audit']);
    const data = (tx.tenantFeaturePackage.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ name: 'Growth', monthlyPrice: '1500000.00', yearlyPrice: '15000000', includedFeatureKeys: ['spin_wheel', 'coupon_engine'] });
    expect(typeof data.monthlyPrice).toBe('string');
    expect((tx.adminAuditLog.create.mock.calls[0] as unknown[])[0]).toMatchObject({
      data: { tenantId: OWNER_TENANT, action: 'tenant_package_create', targetEntityType: 'tenant_feature_package', targetEntityId: PKG },
    });
    expect(view).toMatchObject({ id: PKG, name: 'Growth', isActive: true });
  });

  it('names a taken package name, before the transaction and on a lost race', async () => {
    const taken = build({ nameTaken: true });
    await expect(taken.service.create(actor, input)).rejects.toMatchObject({ reason: 'package_name_taken' });
    expect(taken.prisma.$transaction).not.toHaveBeenCalled();

    const race = build();
    race.prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const e = await race.service.create(actor, input).catch((x) => x);
    expect(e).toBeInstanceOf(TenantPackageRefused);
    expect(e.reason).toBe('package_name_taken');
  });

  it('deactivates by writing isActive alone and audits the before and after', async () => {
    const { service, tx } = build({ existing: stored() });
    const view = await service.update(actor, PKG, { isActive: false });
    const write = (tx.tenantFeaturePackage.update.mock.calls[0] as unknown as [{ where: unknown; data: unknown }])[0];
    expect(write.where).toEqual({ id: PKG });
    expect(write.data).toEqual({ isActive: false });
    const audit = (tx.adminAuditLog.create.mock.calls[0] as unknown as [{ data: unknown }])[0].data;
    expect(audit).toMatchObject({ action: 'tenant_package_update', oldValue: { isActive: true }, newValue: { isActive: false } });
    expect(view.isActive).toBe(false);
  });

  it('refuses an edit that would leave the package with no price', async () => {
    const { service, prisma } = build({ existing: stored() });
    await expect(service.update(actor, PKG, { monthlyPrice: null })).rejects.toMatchObject({ reason: 'package_unpriced' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses clearing a price a subscriber renews on, under the package lock; with none it is cleared (F-019-c)', async () => {
    const both = stored({ yearlyPrice: { toString: () => '15000000' } });
    const busy = build({ existing: both, subscribersOnPeriod: 2 });
    await expect(busy.service.update(actor, PKG, { monthlyPrice: null })).rejects.toMatchObject({ reason: 'package_price_in_use' });
    expect(busy.tx.tenantSubscription.count).toHaveBeenCalledWith({
      where: { packageId: PKG, tenant: { billingModel: { in: ['subscription_monthly'] }, status: { not: 'terminated' } } },
    });
    expect(busy.writes).not.toContain('update');

    const free = build({ existing: both });
    await expect(free.service.update(actor, PKG, { monthlyPrice: null })).resolves.toMatchObject({ monthlyPrice: null });
  });

  it('answers package_not_found for an unknown id', async () => {
    const { service } = build({ existing: null });
    await expect(service.read(actor, PKG)).rejects.toMatchObject({ reason: 'package_not_found' });
    await expect(service.update(actor, PKG, { isActive: false })).rejects.toMatchObject({ reason: 'package_not_found' });
  });

  it.each([['1.5e6'], ['-10'], ['0'], ['0.00'], ['12.345'], [1500000]])('refuses %s as a price', (price) => {
    expect(createPackageSchema.safeParse({ ...input, monthlyPrice: price }).success).toBe(false);
  });

  it('refuses a package with no price, an unknown or repeated feature key, and an unknown field', () => {
    expect(createPackageSchema.safeParse({ ...input, monthlyPrice: undefined, yearlyPrice: undefined }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...input, includedFeatureKeys: ['not_a_feature'] }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...input, includedFeatureKeys: ['spin_wheel', 'spin_wheel'] }).success).toBe(false);
    // D-41: no metering — the unused JSON columns are not the caller's to fill.
    expect(createPackageSchema.safeParse({ ...input, usageIncludedJson: {} }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...input, yearlyPrice: undefined }).success).toBe(true);
    expect(updatePackageSchema.safeParse({}).success).toBe(false);
  });
});
