import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { deliveryItem } from './delivery';
import { RESELLER_TOP_UP_TEMPLATE_KEY, resellerTopUpCandidate } from './reseller-candidates';

/**
 * F-1525-c (ADR-0109 points 4, 8, 11; §24.3): a reseller whose billing wallet
 * runs out inside 7 days at its wholesale pace is suggested a top-up, told to
 * its owner on the F-038-o4 path. Help, not a sale: the money is the
 * reseller's own.
 *
 * The failures worth a spec: a top-up of nothing pitched; one weeks early;
 * one ranked above the upgrade as if it earned something; one told after the
 * reseller already topped up.
 */

const DAY = 86_400_000;
const now = new Date('2026-10-02T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const need = (over: Record<string, unknown> = {}) => ({
  id: 'pred-w',
  predictedAt: at(4.5 * DAY),
  confidence: 0.9,
  value: new Prisma.Decimal('510.00'),
  currencyCode: 'USD',
  reasons: [{ code: 'wholesale_rate', perDay: '20.00', observedDays: 7, balance: '90.00', currencyCode: 'USD' }],
  ...over,
});

describe('resellerTopUpCandidate (F-1525-c)', () => {
  it('a wallet_need inside 7 days: top_up_wallet with the amount as money, deadline the run-out, no margin', () => {
    const c = resellerTopUpCandidate(need(), now);
    expect(c).toMatchObject({ actionType: 'top_up_wallet', confidence: 0.9, predictionId: 'pred-w', templateKey: RESELLER_TOP_UP_TEMPLATE_KEY, deadline: at(4.5 * DAY) });
    expect(c?.reasons[0]).toEqual({ code: 'suggest_top_up', amount: '510.00', currencyCode: 'USD' });
    // Help, not a sale: ranked as zero, so an upgrade the same run wins.
    expect(c?.expectedMargin).toBeUndefined();
  });

  it('none more than 7 days out, none for a top-up of nothing, none already past', () => {
    expect(resellerTopUpCandidate(need({ predictedAt: at(8 * DAY) }), now)).toBeNull();
    expect(resellerTopUpCandidate(need({ value: new Prisma.Decimal('0') }), now)).toBeNull();
    expect(resellerTopUpCandidate(need({ predictedAt: at(-DAY) }), now)).toBeNull();
  });

  it('the take carries the owner, the amount, and the balance then and now', () => {
    const c = resellerTopUpCandidate(need(), now);
    const item = deliveryItem(
      {
        id: 'act-2', tenantId: 'platform', subjectKind: 'tenant', subjectId: 'reseller', actionType: 'top_up_wallet', status: 'scheduled',
        templateKey: RESELLER_TOP_UP_TEMPLATE_KEY, renderedBy: 'template', renderedText: null, deadline: at(4.5 * DAY), reasons: c?.reasons as Prisma.JsonValue,
      },
      undefined,
      { recipientUserId: 'owner', currentPackageId: 'silver', packageName: null, packageNameKey: null, packageActive: false, livePrice: null, productNameKey: null, walletBalance: '95.00' },
    );
    expect(item.amount).toEqual({ amount: '510.00', currencyCode: 'USD' });
    expect(item.reseller).toMatchObject({ recipientUserId: 'owner', packageId: null, balanceThen: '90.00', balanceNow: '95.00' });
  });
});
