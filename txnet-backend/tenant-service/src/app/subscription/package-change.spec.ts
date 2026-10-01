import { Prisma } from '@prisma/client';
import { TenantRenewalService } from '../renewal/tenant-renewal.service';
import { planPackageChange, upgradeChargeReference } from './package-change';
import { TenantSubscriptionService } from './tenant-subscription.service';

/**
 * The invariants F-019-v7 turns on (ADR-0107 point 9, tenant `contract.admin.md`).
 *
 * - An upgrade on the same period applies at once and charges, from the
 *   reseller's billing wallet, the new price for the days left minus the old
 *   one's: (new − old) × days left / days in the period, to the cent.
 * - Monthly -> yearly applies at once: the year's price less the month's
 *   unused days, and the year starts now. Yearly -> monthly, a cheaper or an
 *   equal package wait for the renewal, which applies them — so a quota is
 *   never used high and paid low, and a year paid is never refunded.
 * - A trial or an unpaid period changes at once and free, as before: the
 *   renewal charges the new price.
 * - A wallet short of the charge refuses before anything is written; a paid
 *   upgrade clears the period's held quota terms, so the new package's apply.
 * - The platform owner's `PUT` and the reseller's own change are one rule.
 */
const D = (v: string) => new Prisma.Decimal(v);
const DAY = 86_400_000;
const NOW = new Date('2026-10-11T00:00:00.000Z');
// A month from 2026-09-21 to 2026-10-21: 30 days, 10 left.
const END = new Date('2026-10-21T00:00:00.000Z');

describe('planPackageChange', () => {
  const monthly = 'subscription_monthly' as const;
  const yearly = 'subscription_yearly' as const;
  const base = { samePackage: false, paid: true, periodEnd: END, now: NOW };

  it('an upgrade on the same period charges the difference for the days left, at once', () => {
    const plan = planPackageChange({ ...base, from: { model: monthly, price: D('300'), priceForNewModel: D('300') }, to: { model: monthly, price: D('600') } });
    expect(plan).toEqual({ when: 'now', charge: D('100'), periodEnd: END });
  });

  it('rounds the charge to the cent, half up', () => {
    const plan = planPackageChange({ ...base, from: { model: monthly, price: D('100'), priceForNewModel: D('100') }, to: { model: monthly, price: D('200') } });
    expect(plan.when === 'now' && plan.charge.toFixed(2)).toBe('33.33');
  });

  it('a cheaper or an equal package waits for the renewal', () => {
    expect(planPackageChange({ ...base, from: { model: monthly, price: D('600'), priceForNewModel: D('600') }, to: { model: monthly, price: D('300') } })).toEqual({ when: 'renewal' });
    expect(planPackageChange({ ...base, from: { model: monthly, price: D('600'), priceForNewModel: D('600') }, to: { model: monthly, price: D('600') } })).toEqual({ when: 'renewal' });
  });

  it('monthly -> yearly charges the year less the unused days and starts the year now', () => {
    const plan = planPackageChange({ ...base, samePackage: true, from: { model: monthly, price: D('300'), priceForNewModel: D('3000') }, to: { model: yearly, price: D('3000') } });
    expect(plan).toEqual({ when: 'now', charge: D('2900'), periodEnd: new Date('2027-10-11T00:00:00.000Z') });
  });

  it('monthly -> yearly onto a package cheaper by the year waits for the renewal', () => {
    const plan = planPackageChange({ ...base, from: { model: monthly, price: D('300'), priceForNewModel: D('3000') }, to: { model: yearly, price: D('2000') } });
    expect(plan).toEqual({ when: 'renewal' });
  });

  it('yearly -> monthly waits for the year to end, whatever the package', () => {
    const plan = planPackageChange({ ...base, from: { model: yearly, price: D('3000'), priceForNewModel: D('300') }, to: { model: monthly, price: D('900') } });
    expect(plan).toEqual({ when: 'renewal' });
  });

  it('a trial or an unpaid period changes at once and free', () => {
    const plan = planPackageChange({ ...base, paid: false, from: { model: monthly, price: D('600'), priceForNewModel: D('600') }, to: { model: monthly, price: D('300') } });
    expect(plan).toEqual({ when: 'now', charge: D('0'), periodEnd: END });
  });

  it('the same package and period is no change', () => {
    expect(planPackageChange({ ...base, samePackage: true, from: { model: monthly, price: D('300'), priceForNewModel: D('300') }, to: { model: monthly, price: D('300') } })).toEqual({
      when: 'none',
    });
  });
});

describe('TenantSubscriptionService — changing a paid package (F-019-v7)', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const RESELLER = '44444444-4444-4444-4444-444444444444';
  const SILVER = '55555555-5555-5555-5555-555555555555';
  const GOLD = '33333333-3333-3333-3333-333333333333';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  const build = (opts: { balance?: string; target?: 'gold' | 'silver'; status?: string } = {}) => {
    const writes: string[] = [];
    const silver = { id: SILVER, name: 'Silver', monthlyPrice: D('300'), yearlyPrice: null, includedFeatureKeys: ['a'], isActive: true };
    const gold = { id: GOLD, name: 'Gold', monthlyPrice: D('600'), yearlyPrice: null, includedFeatureKeys: ['a', 'b'], isActive: true };
    const upgrading = (opts.target ?? 'gold') === 'gold';
    const from = upgrading ? silver : gold;
    const target = upgrading ? gold : silver;
    const current = { packageId: from.id, package: from, currentPeriodEnd: END, createdAt: new Date('2026-08-21T00:00:00Z'), nextPackageId: null, nextBillingModel: null };
    const reseller = { id: RESELLER, status: opts.status ?? 'active', billingModel: 'subscription_monthly' };
    const tx = {
      $queryRaw: vi.fn(async () => (writes.push('lock'), [{ id: RESELLER }])),
      tenant: { findUnique: vi.fn(async () => reseller), update: vi.fn(async () => (writes.push('tenant'), {})) },
      tenantFeaturePackage: { findUnique: vi.fn(async () => target) },
      tenantSubscription: {
        findUnique: vi.fn(async () => current),
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => (writes.push('subscription'), { ...current, ...update })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('subscription'), { ...current, ...data })),
      },
      tenantBillingWallet: { findUnique: vi.fn(async () => ({ cachedBalance: D(opts.balance ?? '1000') })) },
      resellerQuotaTermsLock: { deleteMany: vi.fn(async () => (writes.push('terms.unlock'), { count: 2 })) },
      tenantFeatureEntitlement: {
        deleteMany: vi.fn(async () => (writes.push('entitlements.delete'), { count: 1 })),
        createMany: vi.fn(async () => (writes.push('entitlements.create'), { count: 2 })),
        findMany: vi.fn(async () => from.includedFeatureKeys.map((featureKey) => ({ featureKey }))),
      },
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
    };
    const prisma = { tenant: { findUnique: vi.fn(async () => ({ tenantType: 'platform_owner' })) } };
    const all = {
      tenant: { findFirst: vi.fn(async () => reseller) },
      tenantFeaturePackage: { findUnique: vi.fn(async () => target) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const ledger = { debit: vi.fn(async () => (writes.push('debit'), {})) };
    const service = new TenantSubscriptionService(prisma as never, all as never, ledger as never, {} as never);
    return { service, tx, ledger, writes };
  };

  it('an upgrade debits the prorated price, clears the held terms and replaces the keys at once', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const { service, tx, ledger, writes } = build();
      const view = await service.put(actor, RESELLER, { packageId: GOLD, billingModel: 'subscription_monthly' });

      expect(ledger.debit).toHaveBeenCalledWith(tx, {
        tenantId: RESELLER,
        amount: D('100'),
        reasonType: 'subscription_upgrade_charge',
        referenceId: upgradeChargeReference(RESELLER, END, GOLD, 'subscription_monthly'),
      });
      expect(tx.resellerQuotaTermsLock.deleteMany).toHaveBeenCalledWith({ where: { tenantId: RESELLER, periodEnd: END } });
      expect(writes.indexOf('debit')).toBeLessThan(writes.indexOf('subscription'));
      expect(view).toMatchObject({ packageId: GOLD, currentPeriodEnd: END, includedFeatureKeys: ['a', 'b'], charged: '100.00', next: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wallet short of the charge refuses before anything is written', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const { service, writes } = build({ balance: '99.99' });
      await expect(service.put(actor, RESELLER, { packageId: GOLD, billingModel: 'subscription_monthly' })).rejects.toMatchObject({ reason: 'insufficient_balance' });
      expect(writes.filter((w) => w !== 'lock')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a downgrade is scheduled for the renewal: package, keys and money untouched', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const { service, tx, ledger } = build({ target: 'silver' });
      const view = await service.put(actor, RESELLER, { packageId: SILVER, billingModel: 'subscription_monthly' });

      expect(ledger.debit).not.toHaveBeenCalled();
      expect(tx.tenantSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: RESELLER }, data: { nextPackageId: SILVER, nextBillingModel: 'subscription_monthly' } }),
      );
      expect(tx.tenantFeatureEntitlement.deleteMany).not.toHaveBeenCalled();
      expect(view).toMatchObject({ packageId: GOLD, next: { packageId: SILVER, billingModel: 'subscription_monthly' }, charged: null });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TenantRenewalService — a scheduled package (F-019-v7)', () => {
  const TENANT = '44444444-4444-4444-4444-444444444444';
  const GOLD = '33333333-3333-3333-3333-333333333333';
  const SILVER = '55555555-5555-5555-5555-555555555555';

  it('switches to the scheduled package and period, charges its price and copies its keys', async () => {
    const now = new Date(END.getTime() + DAY);
    const sub = {
      packageId: GOLD,
      currentPeriodEnd: END,
      renewalWarnedAt: null,
      graceUntil: null,
      nextPackageId: SILVER,
      nextBillingModel: 'subscription_monthly',
      package: { monthlyPrice: D('600'), yearlyPrice: null, includedFeatureKeys: ['a', 'b'] },
      nextPackage: { monthlyPrice: D('300'), yearlyPrice: null, includedFeatureKeys: ['a'] },
    };
    const locks = [[{ id: GOLD }], [{ id: SILVER }], [{ id: TENANT, tenantType: 'reseller', status: 'active', suspensionCause: null, billingModel: 'subscription_monthly', ownerUserId: 'o' }]];
    const tx = {
      $queryRaw: vi.fn(async () => locks.shift() ?? []),
      tenantSubscription: { findUnique: vi.fn(async () => sub), update: vi.fn(async () => sub) },
      tenantBillingWallet: { findUnique: vi.fn(async () => ({ cachedBalance: D('1000') })) },
      tenantFeatureEntitlement: { deleteMany: vi.fn(async () => ({ count: 1 })), createMany: vi.fn(async () => ({ count: 1 })) },
      tenant: { update: vi.fn(async () => ({})) },
    };
    const all = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      tenantSubscription: { findUnique: vi.fn(async () => ({ currentPeriodEnd: END })) },
      tenantSubscriptionSetting: { findUnique: vi.fn(async () => ({ renewalGraceDays: 3, suspensionHoldDays: 7 })) },
    };
    const ledger = { debit: vi.fn(async () => ({})) };
    await expect(new TenantRenewalService(all as never, ledger as never).renew(TENANT, now)).resolves.toBe('renewed');

    expect((ledger.debit.mock.calls[0] as unknown as [unknown, { amount: Prisma.Decimal }])[1].amount).toEqual(D('300'));
    expect(tx.tenantSubscription.update).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
      data: { currentPeriodEnd: new Date('2026-11-21T00:00:00.000Z'), renewalWarnedAt: null, graceUntil: null, packageId: SILVER, nextPackageId: null, nextBillingModel: null },
    });
    expect(tx.tenantFeatureEntitlement.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: TENANT, featureKey: 'a', isEnabled: true, source: 'package_included', expiresAt: null }],
    });
  });
});
