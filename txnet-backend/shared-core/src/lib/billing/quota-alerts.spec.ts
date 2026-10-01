/**
 * A reseller is told about its quotas (ADR-0107 point 11, F-019-v8). What breaks quietly:
 *
 *  - **a flood.** Each alert — 80%, 100%, stopped — is owed once per window
 *    and period: the act that crosses it writes the row and the outbox event in
 *    its own transaction, and every later act finds the row;
 *  - **a silent stop.** A refused act writes nothing in its transaction (it
 *    rolls back), so the refusal is recorded on a connection of its own: the
 *    day's refused units for the digest, and — once — the "stopped" alert;
 *  - **a digest at 3 a.m., or twice.** Yesterday's refused units and
 *    overage, per reseller, from 09:00 on the platform's quota clock, once.
 */
import { Prisma } from '@prisma/client';

import { OutboxEventType } from '../automation/routing-keys';
import { alertQuotaCrossings, quotaDigests, recordQuotaRefusal } from './quota-alerts';
import { quotaPeriodAt } from './quota-period';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const TEHRAN = 'Asia/Tehran';
// 10:00 in Tehran on Thursday 2026-10-01.
const NOW = new Date('2026-10-01T06:30:00Z');
const DAY = quotaPeriodAt('day', NOW, TEHRAN);
const overage = { mode: 'overage' as const, unitPrice: new Prisma.Decimal('0.50'), currencyCode: 'USD' };
const stop = { mode: 'stop' as const, unitPrice: null, currencyCode: null };

/** The alert table, the outbox and the refusal table, in memory. */
function db() {
  const alerts = new Set<string>();
  const outbox: Array<{ type: string; aggregateId: string; payload: Record<string, unknown> }> = [];
  const refusals = new Map<string, { tenantId: string; meter: string; dayStart: Date; acts: number; units: number }>();
  const tx = {
    resellerQuotaAlert: {
      createMany: async ({ data }: { data: Array<{ tenantId: string; meter: string; period: string; periodStart: Date; level: string }> }) => {
        let count = 0;
        for (const r of data) {
          const k = `${r.tenantId}|${r.meter}|${r.period}|${r.periodStart.toISOString()}|${r.level}`;
          if (!alerts.has(k)) (alerts.add(k), count++);
        }
        return { count };
      },
    },
    tenant: { findUnique: async () => ({ ownerUserId: OWNER }) },
    product: { findFirst: async () => ({ nameKey: 'catalog.product.gold.name' }) },
    outboxEvent: { create: async ({ data }: { data: (typeof outbox)[number] }) => (outbox.push(data), { id: String(outbox.length) }) },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // The refusal upsert: tenantId, meter, dayStart, units, stoppedBy.
      expect(strings.join('?')).toContain('reseller_quota_refusal');
      const [tenantId, meter, dayStart, units] = values as [string, string, Date, number];
      const k = `${tenantId}|${meter}|${dayStart.toISOString()}`;
      const row = refusals.get(k) ?? { tenantId, meter, dayStart, acts: 0, units: 0 };
      refusals.set(k, { ...row, acts: row.acts + 1, units: row.units + units });
      return 1;
    },
    tenantSubscriptionSetting: { findUnique: async () => ({ quotaTimeZone: TEHRAN }) },
  };
  const client = { ...tx, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { tx, client, alerts, outbox, refusals };
}

describe('alertQuotaCrossings — at the act, in its transaction', () => {
  const day = (used: number, included: number | null = 10) => [{ period: DAY, included, used }];

  it('crossing 80% tells once; another act inside 80-99% tells nothing more', async () => {
    const { tx, outbox } = db();
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', windows: day(7), includedQty: 1, overageQty: 0, overage: stop });
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', windows: day(8), includedQty: 1, overageQty: 0, overage: stop });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: OutboxEventType.TENANT_QUOTA_ALERT,
      aggregateId: RESELLER,
      payload: { tenantId: RESELLER, ownerUserId: OWNER, level: '80', mode: 'stop', included: '10', quotaKey: 'campaign_sends_daily_max' },
    });
  });

  it('filling what is included on overage tells "overage started" with the price, once', async () => {
    const { tx, outbox } = db();
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', windows: day(9), includedQty: 1, overageQty: 2, overage });
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', windows: day(10), includedQty: 0, overageQty: 1, overage });
    expect(outbox.map((e) => e.payload)).toEqual([expect.objectContaining({ level: '100', mode: 'overage', unitPrice: '0.50', currencyCode: 'USD' })]);
  });

  it('jumping past 80% straight to 100% tells only 100%; no limit tells nothing', async () => {
    const { tx, outbox } = db();
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', windows: day(5), includedQty: 5, overageQty: 0, overage: stop });
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', windows: day(0, null), includedQty: 50, overageQty: 0, overage: stop });
    expect(outbox.map((e) => e.payload['level'])).toEqual(['100']);
  });

  it("names a product's sales quota by the product's name key", async () => {
    const { tx, outbox } = db();
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'product:p1', windows: day(7), includedQty: 1, overageQty: 0, overage: stop });
    expect(outbox[0].payload).toMatchObject({ productNameKey: 'catalog.product.gold.name' });
    expect(outbox[0].payload).not.toHaveProperty('quotaKey');
  });
});

describe('recordQuotaRefusal — on its own connection, after the act rolled back', () => {
  const refusal = (stoppedBy: 'stop' | 'wallet_empty', qty = 3) => ({
    tenantId: RESELLER,
    meter: 'campaign_sends_daily_max',
    qty,
    stoppedBy,
    included: 10,
    window: DAY,
    overage: stoppedBy === 'stop' ? stop : overage,
    zone: TEHRAN,
    at: NOW,
  });

  it("adds the act's units to the day's refused total", async () => {
    const { client, refusals } = db();
    await recordQuotaRefusal(client as never, refusal('stop', 3));
    await recordQuotaRefusal(client as never, refusal('stop', 2));
    expect([...refusals.values()]).toEqual([{ tenantId: RESELLER, meter: 'campaign_sends_daily_max', dayStart: DAY.start, acts: 2, units: 5 }]);
  });

  it('a stop tells "stopped" once — as the 100% alert, which the act that filled it may already have told', async () => {
    const { tx, client, outbox } = db();
    await alertQuotaCrossings(tx as never, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', windows: [{ period: DAY, included: 10, used: 9 }], includedQty: 1, overageQty: 0, overage: stop });
    await recordQuotaRefusal(client as never, refusal('stop'));
    expect(outbox.map((e) => e.payload['level'])).toEqual(['100']);
  });

  it('an overage the wallet cannot pay tells "stopped" with why, once a period', async () => {
    const { client, outbox } = db();
    await recordQuotaRefusal(client as never, refusal('wallet_empty'));
    await recordQuotaRefusal(client as never, refusal('wallet_empty'));
    expect(outbox.map((e) => e.payload)).toEqual([expect.objectContaining({ level: 'stopped', stoppedBy: 'wallet_empty' })]);
  });
});

describe('quotaDigests — yesterday, from 09:00 on the quota clock', () => {
  const yesterday = quotaPeriodAt('day', new Date(DAY.start.getTime() - 1), TEHRAN);
  const build = () => {
    const d = db();
    const client = {
      ...d.client,
      resellerQuotaRefusal: {
        groupBy: async ({ where }: { where: { dayStart: Date } }) =>
          where.dayStart.getTime() === yesterday.start.getTime() ? [{ tenantId: RESELLER, _sum: { units: 7 } }] : [],
      },
      resellerQuotaUsage: {
        groupBy: async ({ where }: { where: { createdAt: { gte: Date } } }) =>
          where.createdAt.gte.getTime() === yesterday.start.getTime() ? [{ tenantId: RESELLER, currencyCode: 'USD', _sum: { overageQty: 4, overageAmount: new Prisma.Decimal('2.00') } }] : [],
      },
      tenant: { ...d.tx.tenant, findMany: async () => [{ id: RESELLER, ownerUserId: OWNER }] },
    };
    return { ...d, client };
  };

  it('before 09:00 tells nothing', async () => {
    const { client, outbox } = build();
    await expect(quotaDigests(client as never, new Date(DAY.start.getTime() + 8 * 3_600_000 + 59 * 60_000))).resolves.toEqual({ resellers: 0, told: 0 });
    expect(outbox).toEqual([]);
  });

  it("from 09:00 tells each reseller yesterday's refused units and overage, once", async () => {
    const { client, outbox } = build();
    const at = new Date(DAY.start.getTime() + 9 * 3_600_000);
    await expect(quotaDigests(client as never, at)).resolves.toEqual({ resellers: 1, told: 1 });
    await expect(quotaDigests(client as never, at)).resolves.toEqual({ resellers: 1, told: 0 });
    expect(outbox).toEqual([
      expect.objectContaining({
        type: OutboxEventType.TENANT_QUOTA_DIGEST,
        payload: { tenantId: RESELLER, ownerUserId: OWNER, day: yesterday.start.toISOString(), refused: '7', overageUnits: '4', overageCost: '2.00 USD' },
      }),
    ]);
  });
});
