import { Prisma } from '@prisma/client';
import { TenantSubscriptionService } from './tenant-subscription.service';
import { putSubscriptionSchema, updateSubscriptionSettingsSchema } from './tenant-subscription.schema';

/**
 * The invariants F-018-e turns on, at the one surface that writes a reseller's subscription.
 *
 * - Only the platform owner, refused before the cross-tenant pool is touched.
 * - The first package starts the trial: `currentPeriodEnd` = now + the
 *   platform's `trialDays`. A later package or period change keeps
 *   `currentPeriodEnd` — the new price is F-019-c's at the next renewal.
 * - The package's `includedFeatureKeys` replace the tenant's
 *   `package_included` entitlements in the same transaction, under a lock on
 *   the package and then the tenant row; entitlements from any other source are untouched.
 * - A package must be sold for the period asked, and an inactive package
 *   is not offered to a tenant not already on it.
 * - No charge is written here.
 */
describe('TenantSubscriptionService', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const RESELLER = '44444444-4444-4444-4444-444444444444';
  const PKG = '33333333-3333-3333-3333-333333333333';
  const OTHER_PKG = '55555555-5555-5555-5555-555555555555';
  const DAY = 86_400_000;
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  type Opts = {
    callerType?: string;
    reseller?: { id: string; status: string; billingModel: string } | null;
    pkg?: { id: string; name: string; monthlyPrice: unknown; yearlyPrice: unknown; includedFeatureKeys: string[]; isActive: boolean } | null;
    current?: { packageId: string; currentPeriodEnd: Date; createdAt: Date; package?: { name: string } } | null;
    trialDays?: number;
  };

  const build = (opts: Opts = {}) => {
    const writes: string[] = [];
    const reseller = opts.reseller === undefined ? { id: RESELLER, status: 'trial', billingModel: 'subscription_monthly' } : opts.reseller;
    const pkg =
      opts.pkg === undefined
        ? { id: PKG, name: 'Growth', monthlyPrice: { toString: () => '1500000' }, yearlyPrice: null, includedFeatureKeys: ['spin_wheel', 'coupon_engine'], isActive: true }
        : opts.pkg;
    const tx = {
      $queryRaw: vi.fn(async () => (writes.push('lock'), [{ id: RESELLER }])),
      tenantFeaturePackage: { findUnique: vi.fn(async () => pkg) },
      tenantSubscription: {
        findUnique: vi.fn(async () => opts.current ?? null),
        // F-019-v3's lock reads the reseller's period; nothing frozen here (no quota rows to read).
        findMany: vi.fn(async () => (writes.push('quota.lock'), [])),
        upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          writes.push('subscription');
          return opts.current
            ? { ...opts.current, ...update, tenantId: RESELLER }
            : { ...create, createdAt: new Date() };
        }),
      },
      tenant: { findUnique: vi.fn(async () => reseller), update: vi.fn(async () => (writes.push('tenant'), {})) },
      tenantFeatureEntitlement: {
        deleteMany: vi.fn(async () => (writes.push('entitlements.delete'), { count: 1 })),
        createMany: vi.fn(async () => (writes.push('entitlements.create'), { count: 2 })),
        findMany: vi.fn(async () => []),
      },
      tenantBillingTransaction: { create: vi.fn() },
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
    };
    const prisma = { tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) } };
    const all = {
      tenant: { findFirst: vi.fn(async () => reseller) },
      tenantFeaturePackage: { findUnique: vi.fn(async () => pkg) },
      tenantSubscriptionSetting: { findUnique: vi.fn(async () => ({ trialDays: opts.trialDays ?? 14 })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { service: new TenantSubscriptionService(prisma as never, all as never, {} as never, {} as never), all, tx, writes };
  };

  const put = { packageId: PKG, billingModel: 'subscription_monthly' as const };

  it('refuses a caller who is not the platform owner before the cross-tenant pool is touched', async () => {
    const { service, all } = build({ callerType: 'reseller' });
    await expect(service.put(actor, RESELLER, put)).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.tenant.findFirst).not.toHaveBeenCalled();
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('starts the trial on the first package: currentPeriodEnd is now + trialDays, entitlements written, no charge', async () => {
    const { service, tx, writes } = build({ trialDays: 10 });
    const before = Date.now();
    const view = await service.put(actor, RESELLER, put);

    expect(writes).toEqual(['lock', 'lock', 'subscription', 'entitlements.delete', 'entitlements.create', 'audit']);
    const end = view.currentPeriodEnd.getTime();
    expect(end).toBeGreaterThanOrEqual(before + 10 * DAY);
    expect(end).toBeLessThanOrEqual(Date.now() + 10 * DAY);
    expect(tx.tenantFeatureEntitlement.deleteMany).toHaveBeenCalledWith({ where: { tenantId: { in: [RESELLER] }, source: 'package_included' } });
    expect(tx.tenantFeatureEntitlement.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: RESELLER, featureKey: 'spin_wheel', isEnabled: true, source: 'package_included', expiresAt: null },
        { tenantId: RESELLER, featureKey: 'coupon_engine', isEnabled: true, source: 'package_included', expiresAt: null },
      ],
    });
    expect(tx.tenantBillingTransaction.create).not.toHaveBeenCalled();
    expect((tx.adminAuditLog.create.mock.calls[0] as unknown as [{ data: unknown }])[0].data).toMatchObject({
      tenantId: RESELLER,
      action: 'tenant_subscription_set',
      targetEntityType: 'tenant',
      targetEntityId: RESELLER,
      oldValue: Prisma.JsonNull,
    });
    expect(view).toMatchObject({ tenantId: RESELLER, packageId: PKG, packageName: 'Growth', billingModel: 'subscription_monthly', includedFeatureKeys: ['spin_wheel', 'coupon_engine'] });
  });

  it('keeps currentPeriodEnd on a package and period change, and moves the tenant to the new period', async () => {
    const periodEnd = new Date('2026-10-12T00:00:00Z');
    const { service, tx, all, writes } = build({
      current: { packageId: OTHER_PKG, currentPeriodEnd: periodEnd, createdAt: new Date('2026-09-01T00:00:00Z') },
      pkg: { id: PKG, name: 'Growth', monthlyPrice: null, yearlyPrice: { toString: () => '15000000' }, includedFeatureKeys: ['own_sms'], isActive: true },
    });
    const view = await service.put(actor, RESELLER, { packageId: PKG, billingModel: 'subscription_yearly' });

    expect(all.tenantSubscriptionSetting.findUnique).not.toHaveBeenCalled();
    const upsert = (tx.tenantSubscription.upsert.mock.calls[0] as unknown as [{ update: Record<string, unknown> }])[0];
    // An unpaid period (a trial) changes at once and free; a change that was waiting is dropped (F-019-v7).
    expect(upsert.update).toEqual({ packageId: PKG, currentPeriodEnd: periodEnd, nextPackageId: null, nextBillingModel: null });
    expect(tx.tenant.update).toHaveBeenCalledWith({ where: { id: RESELLER }, data: { billingModel: 'subscription_yearly' } });
    expect(view.currentPeriodEnd).toEqual(periodEnd);
    expect(view.includedFeatureKeys).toEqual(['own_sms']);
    // The old package's quotas are frozen for the period before the switch (F-019-v3).
    expect(tx.tenantSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: { in: [RESELLER] } } }));
    expect(writes.indexOf('quota.lock')).toBeLessThan(writes.indexOf('subscription'));
  });

  it('refuses a package not sold for the period asked', async () => {
    const { service, all } = build();
    await expect(service.put(actor, RESELLER, { packageId: PKG, billingModel: 'subscription_yearly' })).rejects.toMatchObject({
      reason: 'package_not_sold_for_period',
    });
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an inactive package to a new subscriber, and keeps it for one already on it', async () => {
    const inactive = { id: PKG, name: 'Growth', monthlyPrice: { toString: () => '1' }, yearlyPrice: null, includedFeatureKeys: [], isActive: false };
    const fresh = build({ pkg: inactive });
    await expect(fresh.service.put(actor, RESELLER, put)).rejects.toMatchObject({ reason: 'package_inactive' });

    const kept = build({ pkg: inactive, current: { packageId: PKG, currentPeriodEnd: new Date(), createdAt: new Date(), package: { name: 'Growth' } } });
    await expect(kept.service.put(actor, RESELLER, put)).resolves.toMatchObject({ packageId: PKG });
  });

  it('names an unknown or terminated reseller and an unknown package', async () => {
    await expect(build({ reseller: null }).service.put(actor, RESELLER, put)).rejects.toMatchObject({ reason: 'reseller_not_found' });
    await expect(
      build({ reseller: { id: RESELLER, status: 'terminated', billingModel: 'subscription_monthly' } }).service.put(actor, RESELLER, put),
    ).rejects.toMatchObject({ reason: 'reseller_terminated' });
    await expect(build({ pkg: null }).service.put(actor, RESELLER, put)).rejects.toMatchObject({ reason: 'package_not_found' });
  });

  it('refuses a metered period, an unknown field, and a trial length outside 0..365 days', () => {
    expect(putSubscriptionSchema.safeParse({ ...put, billingModel: 'pay_as_you_go_metered' }).success).toBe(false);
    expect(putSubscriptionSchema.safeParse({ ...put, currentPeriodEnd: '2027-01-01' }).success).toBe(false);
    expect(updateSubscriptionSettingsSchema.safeParse({ trialDays: 14 }).success).toBe(true);
    expect(updateSubscriptionSettingsSchema.safeParse({ trialDays: -1 }).success).toBe(false);
    expect(updateSubscriptionSettingsSchema.safeParse({ trialDays: 366 }).success).toBe(false);
    expect(updateSubscriptionSettingsSchema.safeParse({ trialDays: 1.5 }).success).toBe(false);
    expect(updateSubscriptionSettingsSchema.safeParse({ renewalGraceDays: 3 }).success).toBe(true);
    expect(updateSubscriptionSettingsSchema.safeParse({ renewalGraceDays: 31 }).success).toBe(false);
    // F-019-v2: the clock a sold quota's day and week are read on — a zone the runtime knows, never a guess.
    expect(updateSubscriptionSettingsSchema.safeParse({ quotaTimeZone: 'Asia/Tehran' }).success).toBe(true);
    expect(updateSubscriptionSettingsSchema.safeParse({ quotaTimeZone: 'Mars/Olympus' }).success).toBe(false);
  });
});
