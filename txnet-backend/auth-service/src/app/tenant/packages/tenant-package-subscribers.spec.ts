import { TenantPackageService } from './tenant-package.service';

/**
 * The invariants F-018-o turns on: what a package's subscribers see when its
 * feature list changes.
 *
 * - A key added to the package is granted to every current subscriber in the
 *   edit's own transaction, after the package and its subscription rows are
 *   locked.
 * - A removed key is left in place — the subscriber paid for the period; the
 *   renewal (F-019-c) re-copies the package.
 * - Forcing replaces every subscriber's `package_included` entitlements with
 *   the package's full list at once, removals included, and is audited.
 * - Only the platform owner, before any package or subscriber row is touched.
 */
describe('TenantPackageService — subscribers', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const PKG = '33333333-3333-3333-3333-333333333333';
  const ACME = '44444444-4444-4444-4444-444444444444';
  const BETA = '55555555-5555-5555-5555-555555555555';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  const stored = (keys: string[]) => ({
    id: PKG,
    name: 'Growth',
    monthlyPrice: { toString: () => '1500000' },
    yearlyPrice: null,
    includedFeatureKeys: keys,
    isActive: true,
  });

  const build = (opts: { callerType?: string; keys?: string[]; subscribers?: string[]; existing?: { tenantId: string; featureKey: string }[] } = {}) => {
    const writes: string[] = [];
    let keys = opts.keys ?? ['spin_wheel', 'coupon_engine'];
    const tx = {
      $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
        const text = sql.join('?');
        if (text.includes('tenant_subscription')) return writes.push('lock.subscribers'), (opts.subscribers ?? [ACME, BETA]).map((tenantId) => ({ tenantId }));
        return writes.push('lock.package'), [{ id: PKG }];
      }),
      tenantFeaturePackage: {
        findUnique: vi.fn(async () => stored(keys)),
        update: vi.fn(async ({ data }: { data: { includedFeatureKeys?: string[] } }) => {
          writes.push('package');
          if (data.includedFeatureKeys) keys = data.includedFeatureKeys;
          return stored(keys);
        }),
      },
      tenantFeatureEntitlement: {
        findMany: vi.fn(async () => opts.existing ?? []),
        deleteMany: vi.fn(async () => (writes.push('entitlements.delete'), { count: 0 })),
        createMany: vi.fn(async () => (writes.push('entitlements.create'), { count: 0 })),
      },
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
    };
    const prisma = {
      tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) },
      tenantFeaturePackage: { findUnique: vi.fn(async ({ where }: { where: { name?: string } }) => (where.name ? null : stored(keys))) },
    };
    const all = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { service: new TenantPackageService(prisma as never, all as never), all, tx, writes };
  };

  it('grants an added key to every subscriber in the edit, and leaves a removed key in place', async () => {
    const { service, tx, writes } = build({ existing: [{ tenantId: BETA, featureKey: 'own_sms' }] });
    await service.update(actor, PKG, { includedFeatureKeys: ['coupon_engine', 'own_sms'] });

    expect(writes).toEqual(['lock.package', 'package', 'lock.subscribers', 'entitlements.create', 'audit']);
    expect(tx.tenantFeatureEntitlement.deleteMany).not.toHaveBeenCalled();
    expect(tx.tenantFeatureEntitlement.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: ACME, featureKey: 'own_sms', isEnabled: true, source: 'package_included', expiresAt: null }],
    });
  });

  it('touches no subscriber when no key was added', async () => {
    const { service, tx, writes } = build();
    await service.update(actor, PKG, { includedFeatureKeys: ['coupon_engine'] });
    await service.update(actor, PKG, { isActive: false });
    expect(writes).not.toContain('lock.subscribers');
    expect(tx.tenantFeatureEntitlement.createMany).not.toHaveBeenCalled();
  });

  it('forces the full list onto every subscriber, removals included, and audits it', async () => {
    const { service, tx, writes } = build({ keys: ['coupon_engine', 'own_sms'] });
    const result = await service.apply(actor, PKG);

    expect(writes).toEqual(['lock.package', 'lock.subscribers', 'entitlements.delete', 'entitlements.create', 'audit']);
    expect(tx.tenantFeatureEntitlement.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: { in: [ACME, BETA] }, source: 'package_included' },
    });
    expect((tx.tenantFeatureEntitlement.createMany.mock.calls[0] as unknown as [{ data: unknown[] }])[0].data).toHaveLength(4);
    expect((tx.adminAuditLog.create.mock.calls[0] as unknown as [{ data: unknown }])[0].data).toMatchObject({
      action: 'tenant_package_apply',
      targetEntityType: 'tenant_feature_package',
      targetEntityId: PKG,
      newValue: { includedFeatureKeys: ['coupon_engine', 'own_sms'], subscribers: 2 },
    });
    expect(result).toEqual({ packageId: PKG, includedFeatureKeys: ['coupon_engine', 'own_sms'], subscribers: 2 });
  });

  it('refuses a caller who is not the platform owner before any row is touched', async () => {
    const { service, all } = build({ callerType: 'reseller' });
    await expect(service.apply(actor, PKG)).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.$transaction).not.toHaveBeenCalled();
  });
});
