import {
  InsufficientFunds,
  RATE_LIMIT_KEY,
  RateLimitBucket,
  RateLimitOptions,
  UnscopedRedisKeys,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';

import { addBillingPeriod, periodChargeReference } from '../renewal/tenant-renewal.service';
import { ResellerPurchaseController } from './reseller-purchase.controller';
import { ResellerPurchaseService } from './reseller-purchase.service';
import { slugFromName } from './slug-suggestion';

/**
 * The invariants F-019-h turns on (ADR-0061):
 *
 * - **All or nothing.** The buyer's wallet debit, the reseller's rows, its
 *   first period's charge and `active` are one transaction on the cross-tenant
 *   pool — money never leaves a wallet without a reseller, and no reseller
 *   exists that nobody paid for.
 * - **The first period is paid**: the price reaches the reseller's billing
 *   wallet and is charged from it, as a renewal would, so its history shows it.
 * - Only a user of the platform owner's tenant buys, one live reseller each.
 * - The slug is suggested from the name the buyer typed, next to it when taken,
 *   and the buyer's own slug wins when sent.
 */
describe('slugFromName', () => {
  it('turns a Latin name into one DNS label', () => {
    expect(slugFromName('  Ali VPN!! ')).toBe('ali-vpn');
    expect(slugFromName('Café__Net 24')).toBe('cafe-net-24');
  });

  it('transliterates a Persian name instead of dropping it', () => {
    expect(slugFromName('علی وی‌پی‌ان')).toBe('aly-vy-py-an');
    expect(slugFromName('شبکه ۲۴')).toBe('shbkh-24');
  });

  it('falls back to a fixed word when nothing usable is left, and keeps within a label', () => {
    expect(slugFromName('!!!')).toBe('reseller');
    expect(slugFromName('a'.repeat(80)).length).toBeLessThanOrEqual(50);
  });
});

describe('ResellerPurchaseService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const BUYER = '33333333-3333-3333-3333-333333333333';
  const PACKAGE = '44444444-4444-4444-4444-444444444444';
  const NEW_TENANT = '55555555-5555-5555-5555-555555555555';
  const NOW = new Date('2026-09-18T10:00:00.000Z');
  const buyer = { userId: BUYER, tenantId: PLATFORM, ip: '127.0.0.1' };
  const input = { packageId: PACKAGE, billingModel: 'subscription_monthly' as const, name: 'Ali VPN' };
  const pkg = { id: PACKAGE, name: 'Pro', isActive: true, monthlyPrice: { toFixed: () => '300000.00' }, yearlyPrice: null, includedFeatureKeys: ['bot', 'domain'] };
  const person = { id: BUYER, fullName: 'Ali', username: 'ali', phoneNumber: '+989123456789', status: 'active' };

  const build = (
    opts: { callerType?: string; taken?: string[]; heldHosts?: string[]; owns?: boolean; short?: boolean; status?: string; package?: Partial<typeof pkg> | null } = {},
  ) => {
    const writes: string[] = [];
    const hosts: string[] = [];
    const appPrisma = { tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) } };
    const tx = {
      $queryRaw: vi.fn(async () => (writes.push('lock package'), [])),
      tenantFeaturePackage: { findUnique: vi.fn(async () => (opts.package === null ? null : { ...pkg, ...opts.package })) },
      tenant: {
        findFirst: vi.fn(async () => (opts.owns ? { id: 'old' } : null)),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('tenant'), { id: NEW_TENANT, ...data, createdAt: NOW })),
      },
      tenantBillingWallet: { create: vi.fn(async () => (writes.push('billing wallet'), {})) },
      tenantDomain: {
        create: vi.fn(
          async ({ data }: { data: Record<string, unknown> }) => (
            writes.push(`domain ${data.domainValue}`), hosts.push(data.domainValue as string), { verificationStatus: 'pending', ...data }
          ),
        ),
        findMany: vi.fn(async () => hosts.map((domainValue) => ({ domainValue }))),
      },
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
      tenantSubscription: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => (writes.push('subscription'), {})) },
      tenantFeatureEntitlement: {
        deleteMany: vi.fn(async () => ({})),
        createMany: vi.fn(async () => (writes.push('entitlements'), {})),
      },
      tenantStatusHistory: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => (writes.push('status history'), {})) },
    };
    Object.assign(tx.tenant, {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push(`status ${data.status}`), { id: NEW_TENANT, ...data })),
    });
    const all = {
      tenant: {
        findFirst: vi.fn(async () => (opts.owns ? { id: 'old' } : null)),
        findMany: vi.fn(async ({ where }: { where: { slug: { in: string[] } } }) =>
          where.slug.in.filter((s) => (opts.taken ?? []).includes(s)).map((slug) => ({ slug })),
        ),
        findUnique: vi.fn(async ({ where }: { where: { slug: string } }) => ((opts.taken ?? []).includes(where.slug) ? { id: 'x' } : null)),
      },
      tenantDomain: {
        findUnique: vi.fn(async ({ where }: { where: { domainValue: string } }) =>
          (opts.heldHosts ?? []).includes(where.domainValue) ? { id: 'h' } : null,
        ),
        findMany: vi.fn(async ({ where }: { where: { domainValue: { in: string[] } } }) =>
          where.domainValue.in.filter((h) => (opts.heldHosts ?? []).includes(h)).map((domainValue) => ({ domainValue })),
        ),
      },
      tenantFeaturePackage: {
        findUnique: vi.fn(async () => (opts.package === null ? null : { ...pkg, ...opts.package })),
        findMany: vi.fn(async () => [pkg]),
      },
      user: { findFirst: vi.fn(async () => ({ ...person, status: opts.status ?? 'active' })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const redis = { del: vi.fn(async (key: string) => void writes.push(`del ${key}`)) };
    const config = { get: vi.fn(() => 'txnet.app') };
    const wallets = {
      debit: vi.fn(async (_tx: unknown, entry: { amount: unknown }) => {
        if (opts.short) throw new InsufficientFunds(BUYER);
        writes.push('user wallet debit');
        return { balanceAfter: { toFixed: () => '200000.00' }, amount: entry.amount };
      }),
    };
    const billing = {
      credit: vi.fn(async (_tx: unknown, _entry: Record<string, unknown>) => (writes.push('billing credit'), {})),
      debit: vi.fn(async (_tx: unknown, _entry: Record<string, unknown>) => (writes.push('billing debit'), {})),
    };
    const service = new ResellerPurchaseService(appPrisma as never, all as never, redis as never, config as never, wallets as never, billing as never);
    return { service, all, tx, wallets, billing, writes };
  };

  it('refuses a user of a reseller before the cross-tenant pool is touched', async () => {
    const { service, all } = build({ callerType: 'reseller' });
    await expect(service.purchase(buyer, input, NOW)).rejects.toMatchObject({ reason: 'not_platform_user' });
    await expect(service.suggestSlug(buyer, 'Ali VPN')).rejects.toMatchObject({ reason: 'not_platform_user' });
    expect(all.tenantFeaturePackage.findUnique).not.toHaveBeenCalled();
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('suggests the name’s slug, or the next free one beside it', async () => {
    expect(await build().service.suggestSlug(buyer, 'Ali VPN')).toEqual({ slug: 'ali-vpn' });
    expect(await build({ taken: ['ali-vpn', 'ali-vpn-2'] }).service.suggestSlug(buyer, 'Ali VPN')).toEqual({ slug: 'ali-vpn-3' });
    // A slug whose CNAME target is already held is taken too, with no tenant row
    // naming it — the host is what the unique index stands behind (ADR-0063).
    expect(
      await build({ heldHosts: ['ali-vpn.edge.txnet.app'] }).service.suggestSlug(buyer, 'Ali VPN'),
    ).toEqual({ slug: 'ali-vpn-2' });
    // A reserved label is never suggested: `admin.txnet.app` is the platform's.
    expect(await build().service.suggestSlug(buyer, 'Admin')).toEqual({ slug: 'admin-2' });
  });

  it('pays the first period and opens the reseller active, all in one transaction', async () => {
    const { service, all, tx, wallets, billing, writes } = build();
    const view = await service.purchase(buyer, input, NOW);

    expect(all.$transaction).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([
      'lock package',
      'tenant',
      'billing wallet',
      'domain ali-vpn.edge.txnet.app',
      'audit',
      `del ${UnscopedRedisKeys.tenantById(NEW_TENANT)}`,
      `del ${UnscopedRedisKeys.tenantByHost('ali-vpn.edge.txnet.app')}`,
      'user wallet debit',
      'billing credit',
      'billing debit',
      'subscription',
      'entitlements',
      'status active',
      'status history',
    ]);
    // The buyer's wallet, in the platform owner's scope, referenced by the reseller it bought.
    expect(wallets.debit.mock.calls[0][1]).toMatchObject({ userId: BUYER, reasonType: 'reseller_purchase', referenceId: NEW_TENANT, tenantId: PLATFORM });
    expect(tx.tenant.create.mock.calls[0][0].data).toMatchObject({ ownerUserId: BUYER, slug: 'ali-vpn', status: 'trial' });
    expect(billing.credit.mock.calls[0][1]).toMatchObject({ tenantId: NEW_TENANT, reasonType: 'reseller_purchase', referenceId: NEW_TENANT });
    expect(billing.debit.mock.calls[0][1]).toMatchObject({
      tenantId: NEW_TENANT,
      reasonType: 'subscription_charge',
      referenceId: periodChargeReference(NEW_TENANT, NOW),
    });
    expect(tx.tenantSubscription.create.mock.calls[0][0].data).toEqual({
      tenantId: NEW_TENANT,
      packageId: PACKAGE,
      currentPeriodEnd: addBillingPeriod(NOW, 'subscription_monthly'),
    });
    expect(tx.tenantStatusHistory.create.mock.calls[0][0].data).toMatchObject({ fromStatus: 'trial', toStatus: 'active', actorUserId: BUYER });
    expect(view).toMatchObject({ status: 'active', slug: 'ali-vpn', charged: '300000.00', walletBalance: '200000.00' });
  });

  it('takes the buyer’s own slug over the suggestion, and refuses it when taken', async () => {
    const own = build();
    await own.service.purchase(buyer, { ...input, slug: 'fast-net' }, NOW);
    expect(own.tx.tenant.create.mock.calls[0][0].data).toMatchObject({ slug: 'fast-net' });

    const taken = build({ taken: ['fast-net'] });
    await expect(taken.service.purchase(buyer, { ...input, slug: 'fast-net' }, NOW)).rejects.toMatchObject({ reason: 'slug_taken' });
    expect(taken.all.$transaction).not.toHaveBeenCalled();
  });

  it('a short wallet refuses the purchase from inside the transaction, so nothing it wrote commits', async () => {
    const { service, all, billing } = build({ short: true });
    await expect(service.purchase(buyer, input, NOW)).rejects.toMatchObject({ reason: 'insufficient_balance' });
    expect(all.$transaction).toHaveBeenCalledTimes(1);
    expect(billing.credit).not.toHaveBeenCalled();
  });

  it('refuses a second live reseller for the same user, checked again under the package lock', async () => {
    const { service, all } = build({ owns: true });
    await expect(service.purchase(buyer, input, NOW)).rejects.toMatchObject({ reason: 'already_reseller' });
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a package that is withdrawn or not sold for the period', async () => {
    await expect(build({ package: null }).service.purchase(buyer, input, NOW)).rejects.toMatchObject({ reason: 'package_not_found' });
    await expect(build({ package: { isActive: false } }).service.purchase(buyer, input, NOW)).rejects.toMatchObject({ reason: 'package_inactive' });
    await expect(
      build().service.purchase(buyer, { ...input, billingModel: 'subscription_yearly' }, NOW),
    ).rejects.toMatchObject({ reason: 'package_not_sold_for_period' });
  });

  it('refuses a buyer who is not active', async () => {
    await expect(build({ status: 'banned' }).service.purchase(buyer, input, NOW)).rejects.toMatchObject({ reason: 'buyer_inactive' });
  });
});

describe('ResellerPurchaseController', () => {
  const limitOf = (route: keyof ResellerPurchaseController) =>
    Reflect.getMetadata(RATE_LIMIT_KEY, ResellerPurchaseController.prototype[route]) as RateLimitOptions | undefined;

  it('limits every route per user: reads share one budget, a purchase has its own', () => {
    const req = { identity: { userId: 'u-1', tenantId: 't-1' } };
    expect(limitOf('packages')?.configKey).toBe('RESELLER_PURCHASE_READ_RATE_LIMIT');
    expect(limitOf('slug')?.configKey).toBe('RESELLER_PURCHASE_READ_RATE_LIMIT');
    expect(limitOf('purchase')?.configKey).toBe('RESELLER_PURCHASE_WRITE_RATE_LIMIT');
    // Built from the caller, so one user never spends another's allowance.
    expect(limitOf('packages')?.key(req)).toBe(rateLimitBucketKey(RateLimitBucket.RESELLER_PURCHASE_READ, 'u-1'));
    expect(limitOf('slug')?.key(req)).toBe(rateLimitBucketKey(RateLimitBucket.RESELLER_PURCHASE_READ, 'u-1'));
    expect(limitOf('purchase')?.key(req)).toBe(rateLimitBucketKey(RateLimitBucket.RESELLER_PURCHASE_WRITE, 'u-1'));
    expect(limitOf('purchase')?.windowSec).toBe(900);
  });
});
