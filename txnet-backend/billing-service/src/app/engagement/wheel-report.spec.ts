/**
 * The wheel's day report and its 80% alert (F-707-e, ADR-0111 point 4).
 *
 * What would break silently here, and nowhere else:
 *  - the alert told on every spin past 80%, or never: once a tenant day, the
 *    spin that crosses it, marked under the day row's lock;
 *  - the alert told to one person when the tenant has several admins, or to
 *    a user who cannot change the wheel;
 *  - a report that counts a refused spin as a spin, or a pick that became
 *    nothing as the prize it was picked as.
 */
import { Prisma, SpinAttemptStatus, SpinPrizeType } from '@prisma/client';
import { OutboxEventType, runWithTenant } from '@txnet-backend/shared-core';

import { alertCapCrossing, WheelReportRefused, WheelReportService } from './wheel-report';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN_A = '99999999-9999-4999-8999-999999999991';
const ADMIN_B = '99999999-9999-4999-8999-999999999992';
const AT = new Date('2026-10-03T12:00:00Z');
const DAY = new Date('2026-10-03T00:00:00Z');
const D = (v: number | string) => new Prisma.Decimal(v);

function alertTx(admins = [ADMIN_A, ADMIN_B]) {
  const events: Record<string, unknown>[] = [];
  const marks: Record<string, unknown>[] = [];
  const userQueries: Record<string, unknown>[] = [];
  const tx = {
    spinWheelDay: { updateMany: async (a: Record<string, unknown>) => (marks.push(a), { count: 1 }) },
    user: { findMany: async (a: Record<string, unknown>) => (userQueries.push(a), admins.map((id) => ({ id }))) },
    userGroupMember: { findMany: async () => [] },
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => (events.push(data), { id: `ev-${events.length}` }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, events, marks, userQueries };
}

const crossing = (over = {}) => ({ tenantId: TENANT, tenantDay: DAY, spent: D(8), cap: D(10), currencyCode: 'USD', alertedAt: null as Date | null, at: AT, ...over });

describe('alertCapCrossing', () => {
  it('at 80% of the cap, marks the day and tells each admin who may change the wheel, once each', async () => {
    const { tx, events, marks, userQueries } = alertTx();
    expect(await alertCapCrossing(tx, crossing())).toBe(2);
    expect(marks[0]).toMatchObject({ where: { tenantId: TENANT, tenantDay: DAY, capAlertedAt: null }, data: { capAlertedAt: AT } });
    expect(JSON.stringify(userQueries[0])).toContain('engagement.manage');
    expect(events.map((e) => [e.type, (e.payload as Record<string, string>).userId])).toEqual([
      [OutboxEventType.TENANT_WHEEL_CAP_NEARING, ADMIN_A],
      [OutboxEventType.TENANT_WHEEL_CAP_NEARING, ADMIN_B],
    ]);
    expect(events[0].payload).toMatchObject({ tenantId: TENANT, day: '2026-10-03', spent: '8.00', cap: '10.00', currencyCode: 'USD' });
  });

  it.each([
    ['under 80%', { spent: D('7.99') }],
    ['a day already told', { alertedAt: AT }],
    ['a cap of zero', { cap: D(0), spent: D(0) }],
  ])('tells nobody for %s', async (_why, over) => {
    const { tx, events, marks } = alertTx();
    expect(await alertCapCrossing(tx, crossing(over))).toBe(0);
    expect([events, marks]).toEqual([[], []]);
  });
});

describe('WheelReportService.report', () => {
  const day4 = new Date('2026-10-04T00:00:00Z');
  function build() {
    const tx = {
      $executeRaw: async () => 0,
      tenant: { findUnique: async () => ({ timezone: 'UTC' }) },
      spinWheelDay: {
        findMany: async () => [
          { tenantDay: DAY, costSpent: D(9), spins: 4, capAlertedAt: AT, currencyCode: 'USD', wheelConfig: { version: 2, dailyBudgetCapAmount: D(10) } },
        ],
      },
      spinWheelAttempt: {
        groupBy: async () => [
          { tenantDay: DAY, status: SpinAttemptStatus.awarded, refusalReason: null, prizeAwardedId: 'p1', _count: { _all: 2 }, _sum: { costAmount: D(8) } },
          { tenantDay: DAY, status: SpinAttemptStatus.awarded, refusalReason: null, prizeAwardedId: null, _count: { _all: 2 }, _sum: { costAmount: D(0) } },
          { tenantDay: DAY, status: SpinAttemptStatus.rejected_ineligible, refusalReason: 'daily_limit', prizeAwardedId: null, _count: { _all: 3 }, _sum: { costAmount: D(0) } },
          { tenantDay: DAY, status: SpinAttemptStatus.voided_fraud, refusalReason: 'shared_device', prizeAwardedId: null, _count: { _all: 1 }, _sum: { costAmount: D(0) } },
        ],
      },
      spinWheelPrize: { findMany: async () => [{ id: 'p1', position: 1, label: '1 GB', prizeType: SpinPrizeType.bonus_traffic_gb }] },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    return new WheelReportService(prisma as never, () => AT);
  }
  const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
  const actor = { adminId: ADMIN_A, tenantId: TENANT, ip: '203.0.113.9' };

  it('per tenant day: spins, refusals by reason, prizes given and nothing, cost against the cap', async () => {
    const [r] = await asTenant(() => build().report(actor, {}));
    expect(r).toMatchObject({
      day: '2026-10-03',
      version: 2,
      spins: 4,
      refused: 4,
      refusals: { daily_limit: 3, shared_device: 1 },
      nothing: 2,
      prizes: [{ prizeId: 'p1', position: 1, label: '1 GB', count: 2, cost: '8.00' }],
      costSpent: '9.00',
      cap: '10.00',
      capUsedPercent: '90.00',
      alertedAt: AT.toISOString(),
    });
  });

  it('refuses a range that ends before it starts, or spans more than 31 days', async () => {
    await expect(asTenant(() => build().report(actor, { from: '2026-10-04', to: '2026-10-03' }))).rejects.toBeInstanceOf(WheelReportRefused);
    await expect(asTenant(() => build().report(actor, { from: '2026-08-01', to: day4.toISOString().slice(0, 10) }))).rejects.toMatchObject({ reason: 'invalid_range' });
  });
});
