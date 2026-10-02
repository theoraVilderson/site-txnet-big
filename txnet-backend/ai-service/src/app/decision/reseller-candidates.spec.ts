import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { deliveryItem } from './delivery';
import { OptOuts } from './opt-out';
import { packageUpgradeCandidate, type PackageOption, type ResellerUpgradeInputs } from './reseller-candidates';

/**
 * F-038-o4 (ADR-0109 points 4, 8; ADR-0107 point 9): the upgrade the engine
 * suggests to a reseller before a quota runs out.
 *
 * The failures worth a spec: a "bigger" package that does not raise the quota
 * at risk (a pitch that fixes nothing); a cheaper package called an upgrade
 * (ADR-0107 makes a downgrade wait for the renewal, so it unlocks nothing
 * now); a key the platform set for this reseller alone, which no package
 * changes; a pitch weeks before the run-out; prices compared across two
 * currencies.
 */

const DAY = 86_400_000;
const now = new Date('2026-10-02T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const KEY = 'campaign_sends_daily_max';

const pkg = (id: string, monthly: string | null, limit: number | null | undefined, over: Partial<PackageOption> = {}): PackageOption => ({
  id,
  name: id,
  isActive: true,
  monthlyPrice: monthly === null ? null : new Prisma.Decimal(monthly),
  yearlyPrice: null,
  currencyCode: 'USD',
  limits: limit === undefined ? new Map() : new Map([[KEY, limit]]),
  products: new Map(),
  ...over,
});

function inputs(over: Partial<ResellerUpgradeInputs> = {}): ResellerUpgradeInputs {
  return {
    prediction: {
      id: 'pred-1',
      predictedAt: at(3 * DAY),
      confidence: 0.9,
      // 600 of 1000 used, 100 a day, 20 days left in the month: 2600 needed by its end.
      reasons: [{ code: 'quota_rate', meter: KEY, period: 'month', periodEnd: at(20 * DAY).toISOString(), included: 1000, used: 600, overageQty: 0, mode: 'stop', perDay: 100 }],
    },
    packageId: 'silver',
    billingModel: 'subscription_monthly',
    packages: [pkg('silver', '50.00', 1000), pkg('gold', '90.00', 5000), pkg('platinum', '150.00', null), pkg('bronze', '20.00', 10000)],
    ownLimitKeys: new Set(),
    ...over,
  };
}

describe('packageUpgradeCandidate (F-038-o4)', () => {
  it('names the cheapest pricier package whose quota holds the rest of the window, with 25% to spare', () => {
    const c = packageUpgradeCandidate(inputs(), now);
    expect(c).toMatchObject({ actionType: 'resize_up', confidence: 0.9, predictionId: 'pred-1', templateKey: 'notifications.suggestion.package_upgrade', deadline: at(20 * DAY) });
    expect(c?.reasons[0]).toMatchObject({ code: 'suggest_package', fromPackageId: 'silver', packageId: 'gold', price: '90.00', currencyCode: 'USD', meter: KEY, period: 'month', included: 1000, used: 600, newIncluded: 5000, need: 3250 });
    // What the engine weighs is the extra the platform earns: (90 − 50) × 0.9.
    expect(c?.expectedMargin).toEqual({ amount: '36.00', currencyCode: 'USD' });
  });

  it('never calls a cheaper package an upgrade, and counts no limit as holding anything', () => {
    const c = packageUpgradeCandidate(inputs({ packages: [pkg('silver', '50.00', 1000), pkg('bronze', '20.00', 10000), pkg('platinum', '150.00', null)] }), now);
    expect(c?.reasons[0]).toMatchObject({ packageId: 'platinum', newIncluded: null });
  });

  it('when none holds the need, the biggest step up; a package that does not raise this quota is no step', () => {
    const c = packageUpgradeCandidate(
      inputs({ packages: [pkg('silver', '50.00', 1000), pkg('gold', '90.00', 1500), pkg('ruby', '95.00', 2000), pkg('flat', '120.00', 1000), pkg('blank', '130.00', undefined)] }),
      now,
    );
    expect(c?.reasons[0]).toMatchObject({ packageId: 'ruby', newIncluded: 2000 });
    expect(packageUpgradeCandidate(inputs({ packages: [pkg('silver', '50.00', 1000), pkg('flat', '120.00', 1000)] }), now)).toBeNull();
  });

  it('says nothing for a key the platform set for this reseller alone, or a run-out more than 7 days away', () => {
    expect(packageUpgradeCandidate(inputs({ ownLimitKeys: new Set([KEY]) }), now)).toBeNull();
    const far = inputs();
    far.prediction = { ...(far.prediction as NonNullable<ResellerUpgradeInputs['prediction']>), predictedAt: at(8 * DAY) };
    expect(packageUpgradeCandidate(far, now)).toBeNull();
  });

  it('a product\'s sales: only a package that lists the product, by the window\'s own column; never across currencies', () => {
    const product = inputs({
      prediction: { id: 'pred-2', predictedAt: now, confidence: 0.95, reasons: [{ code: 'quota_full', meter: 'product:p1', period: 'day', periodEnd: at(0.5 * DAY).toISOString(), included: 10, used: 10, overageQty: 4, mode: 'overage' }] },
      packages: [
        pkg('silver', '50.00', undefined, { products: new Map([['p1', { day: 10, week: null, month: null }]]) }),
        pkg('gold', '90.00', undefined, { products: new Map([['p1', { day: 30, week: null, month: 300 }]]) }),
        pkg('euro', '60.00', undefined, { currencyCode: 'EUR', products: new Map([['p1', { day: 100, week: null, month: null }]]) }),
        pkg('other', '70.00', undefined, { products: new Map([['p2', { day: 100, week: null, month: null }]]) }),
      ],
    });
    const c = packageUpgradeCandidate(product, now);
    // A full window: what was sold in it, past the quota too, is the need — (10 + 4) × 1.25.
    expect(c?.reasons[0]).toMatchObject({ packageId: 'gold', newIncluded: 30, need: 18, period: 'day' });
    expect(c?.deadline).toEqual(at(0.5 * DAY));
  });

  it('needs a current package priced for the reseller\'s period', () => {
    expect(packageUpgradeCandidate(inputs({ packageId: null }), now)).toBeNull();
    expect(packageUpgradeCandidate(inputs({ billingModel: 'subscription_yearly' }), now)).toBeNull();
  });
});

describe('telling it (F-038-o4)', () => {
  const PLATFORM = '00000000-0000-4000-8000-0000000000f1';
  const RESELLER = '00000000-0000-4000-8000-0000000000a1';
  const OWNER = '00000000-0000-4000-8000-0000000000b1';
  const row = {
    id: 'act-1', tenantId: PLATFORM, subjectKind: 'tenant' as const, subjectId: RESELLER, actionType: 'resize_up' as const, status: 'scheduled' as const,
    templateKey: 'notifications.suggestion.package_upgrade', renderedBy: 'template' as const, renderedText: null, deadline: at(20 * DAY),
    reasons: [{ code: 'suggest_package', fromPackageId: 'silver', packageId: 'gold', price: '90.00', currencyCode: 'USD', billingModel: 'subscription_monthly', meter: KEY, period: 'month', included: 1000, used: 600, newIncluded: 5000, need: 3250 }],
  };

  it('a reseller\'s row carries its owner, the package as it is now, and the quota — a user\'s carries none of it', () => {
    const item = deliveryItem(row, undefined, { recipientUserId: OWNER, currentPackageId: 'silver', packageName: 'Gold', packageActive: true, livePrice: '95.00', productNameKey: null });
    expect(item.reseller).toEqual({
      recipientUserId: OWNER, currentPackageId: 'silver', fromPackageId: 'silver', packageId: 'gold', packageName: 'Gold', packageActive: true,
      price: { amount: '95.00', currencyCode: 'USD' }, meter: KEY, period: 'month', included: 1000, used: 600, newIncluded: 5000, productNameKey: null,
    });
    expect(deliveryItem({ ...row, subjectKind: 'user' }).reseller).toBeNull();
  });

  it('a package no longer priced for the period is told as unavailable (price null), never at the decided price', () => {
    const item = deliveryItem(row, undefined, { recipientUserId: OWNER, currentPackageId: 'silver', packageName: 'Gold', packageActive: true, livePrice: null, productNameKey: null });
    expect(item.reseller?.price).toBeNull();
  });

  it('the owner\'s tap opts the reseller out — the action is the reseller\'s, the tapper its owner; anyone else 404', async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      aiAction: {
        findFirst: vi.fn(async (q: { where: { subjectKind: string } }) => (q.where.subjectKind === 'tenant' ? { subjectId: RESELLER, actionType: 'resize_up' } : null)),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      aiOptOut: { createMany: vi.fn(async () => ({ count: 1 })) },
      tenant: { findFirst: vi.fn(async (q: { where: { ownerUserId: string } }) => (q.where.ownerUserId === OWNER ? { id: RESELLER } : null)) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const optOuts = new OptOuts(prisma as never);
    await expect(optOuts.optOutFrom({ tenantId: PLATFORM, kind: 'user', id: OWNER }, 'act-1', now)).resolves.toEqual({ actionType: 'resize_up' });
    expect(tx.aiOptOut.createMany).toHaveBeenCalledWith({ data: [{ tenantId: PLATFORM, subjectKind: 'tenant', subjectId: RESELLER, actionType: 'resize_up', createdAt: now }], skipDuplicates: true });
    await expect(optOuts.optOutFrom({ tenantId: PLATFORM, kind: 'user', id: '00000000-0000-4000-8000-0000000000c1' }, 'act-1', now)).resolves.toBeNull();
  });
});
