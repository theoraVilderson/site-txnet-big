/**
 * "This user costs more than they pay" (F-1003, billing/contract.analytics-tabs.md
 * "Loss alert"; the threshold ADR-0149 (4)).
 *
 * The ways this goes wrong quietly:
 *
 *  - **an alert at the threshold, not past it.** Cost over net by more than
 *    the tenant's percent is the rule; exactly at it is not a loss to report;
 *  - **a free user never reported.** Paid nothing and cost something is over
 *    any threshold — dividing by their net would have hidden them;
 *  - **an unconverted cost compared with a sale.** Only the operating
 *    currency's figures are judged; dollars are never weighed against tomans;
 *  - **told twice, or told to nobody.** One claim per user per tenant month,
 *    one notice per recipient, each naming the person who costs the money;
 *  - **a threshold that cannot be set, or set wrong.** 0–500 whole percent,
 *    and a settings write must change something.
 */
import { Prisma } from '@prisma/client';

import { LOSS_ALERT_DEFAULT_PERCENT, lossNoticesOf, monthOf, usersOverThreshold } from './analytics-loss';
import { analyticsSettingsSchema } from './analytics-settings';

const d = (v: string) => new Prisma.Decimal(v);
const row = (userId: string, net: string, cost: string, currencyCode = 'IRT') => ({ userId, currencyCode, net: d(net), cost: d(cost) });

describe('usersOverThreshold', () => {
  it('reports a cost past net by more than the percent, and not one at it', () => {
    const over = usersOverThreshold([row('past', '100', '120.01'), row('at', '100', '120'), row('under', '100', '90')], { percent: 20, operating: 'IRT' });
    expect(over.map((u) => u.userId)).toEqual(['past']);
  });

  it('reports a user who paid nothing and cost something, never one who cost nothing', () => {
    const over = usersOverThreshold([row('free', '0', '0.5'), row('idle', '0', '0')], { percent: 500, operating: 'IRT' });
    expect(over.map((u) => u.userId)).toEqual(['free']);
  });

  it('judges the operating currency only', () => {
    expect(usersOverThreshold([row('usd', '0', '5', 'USD')], { percent: 0, operating: 'IRT' })).toEqual([]);
  });

  it('defaults to twenty percent', () => {
    expect(LOSS_ALERT_DEFAULT_PERCENT).toBe(20);
  });
});

describe('monthOf', () => {
  it('is the first day of the tenant month a day is in', () => {
    expect(monthOf('2026-10-16')).toBe('2026-10-01');
  });
});

describe('lossNoticesOf', () => {
  it('writes one notice per recipient, each naming the user, the figures as decimal strings', () => {
    const notices = lossNoticesOf({ tenantId: 't', userId: 'u', name: 'Sara', net: d('100'), cost: d('130.5'), currencyCode: 'IRT', percent: 20 }, ['a', 'b']);
    expect(notices).toEqual([
      { tenantId: 't', userId: 'a', lossUserId: 'u', name: 'Sara', net: '100.00', cost: '130.50', currencyCode: 'IRT', percent: '20' },
      { tenantId: 't', userId: 'b', lossUserId: 'u', name: 'Sara', net: '100.00', cost: '130.50', currencyCode: 'IRT', percent: '20' },
    ]);
  });
});

describe('analyticsSettingsSchema', () => {
  it('takes the threshold 0..500 whole percent, beside or without the renewal window, and refuses an empty write', () => {
    for (const lossAlertPercent of [0, 20, 500]) expect(analyticsSettingsSchema.safeParse({ lossAlertPercent }).success).toBe(true);
    for (const lossAlertPercent of [-1, 501, 2.5, '20']) expect(analyticsSettingsSchema.safeParse({ lossAlertPercent }).success).toBe(false);
    expect(analyticsSettingsSchema.safeParse({ renewalWindowDays: 7, lossAlertPercent: 30 }).success).toBe(true);
    expect(analyticsSettingsSchema.safeParse({}).success).toBe(false);
  });
});
