import { PaymentStatus } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { announceOpenPayment, settleOpen } from './open-payment';

/**
 * RT-1-j: the manual-payments list is every open payment, and the platform
 * owner reads every tenant's. What breaks silently here: a write that moves
 * the list announces on one channel only (the platform owner never sees a
 * reseller's top-up arrive), a settle that matched nothing still announces,
 * or the expired guard is tried before pending (the coupon holds decision
 * reads which one matched).
 */

const PLATFORM = '00000000-0000-4000-8000-00000000000a';
const RESELLER = '00000000-0000-4000-8000-00000000000b';
const PAYMENT = '00000000-0000-4000-8000-0000000000c1';
const OWNER = '00000000-0000-4000-8000-0000000000d1';
const PAYER = '00000000-0000-4000-8000-0000000000e1';

function fakeTx(opts: { paymentTenant: string | null; matches?: PaymentStatus[]; owner?: string | null; payer?: string | null }) {
  const outbox: { aggregate: string; aggregateId: string; type: string; payload: Record<string, unknown> }[] = [];
  const tried: PaymentStatus[] = [];
  const tx = {
    tenant: {
      findFirst: async () => ({ id: PLATFORM }),
      // `owner` undefined: the reseller has one; null: it has none.
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === RESELLER ? { ownerUserId: opts.owner === undefined ? OWNER : opts.owner } : { ownerUserId: null },
    },
    paymentTransaction: {
      findUnique: async () => ({ tenantId: opts.paymentTenant, userId: opts.payer === undefined ? PAYER : opts.payer }),
      updateMany: async (args: { where: { status: PaymentStatus } }) => {
        tried.push(args.where.status);
        return { count: opts.matches?.includes(args.where.status) ? 1 : 0 };
      },
    },
    outboxEvent: {
      create: async (args: { data: (typeof outbox)[number] }) => void outbox.push(args.data),
    },
  };
  return { tx: tx as never, outbox, tried };
}

describe('announceOpenPayment', () => {
  it("writes one row for the payment's tenant and one for the platform owner, ids only", async () => {
    const { tx, outbox } = fakeTx({ paymentTenant: RESELLER, owner: null, payer: null });
    await announceOpenPayment(tx, PAYMENT);
    expect(outbox).toEqual(
      [RESELLER, PLATFORM].map((tenantId) => ({
        aggregate: 'billing.payment',
        aggregateId: PAYMENT,
        type: OutboxEventType.PAYMENT_OPEN_CHANGED,
        payload: { tenantId, paymentId: PAYMENT },
      })),
    );
  });

  it("tells a reseller's owner too, on their own channel: they sit in the platform's tenant (F-093-v)", async () => {
    const { tx, outbox } = fakeTx({ paymentTenant: RESELLER });
    await announceOpenPayment(tx, PAYMENT);
    expect(outbox.map((o) => o.type)).toEqual([
      OutboxEventType.PAYMENT_OPEN_CHANGED,
      OutboxEventType.PAYMENT_OPEN_CHANGED,
      OutboxEventType.PAYMENT_RESELLER_OPEN_CHANGED,
      OutboxEventType.PAYMENT_CHANGED,
    ]);
    expect(outbox[2]).toEqual({
      aggregate: 'billing.payment',
      aggregateId: PAYMENT,
      type: OutboxEventType.PAYMENT_RESELLER_OPEN_CHANGED,
      payload: { userId: OWNER, resellerId: RESELLER, paymentId: PAYMENT },
    });
  });

  it("writes one row when the payment is the platform's own, or has no tenant", async () => {
    for (const paymentTenant of [PLATFORM, null]) {
      const { tx, outbox } = fakeTx({ paymentTenant, payer: null });
      await announceOpenPayment(tx, PAYMENT);
      expect(outbox.map((o) => o.payload['tenantId'])).toEqual([PLATFORM]);
    }
  });
});

describe('announceOpenPayment — the payer', () => {
  it('tells the payer on their own channel, whatever the status moved to: a rejection or an expiry has no other event for them', async () => {
    const { tx, outbox } = fakeTx({ paymentTenant: PLATFORM });
    await announceOpenPayment(tx, PAYMENT);
    expect(outbox.at(-1)).toEqual({
      aggregate: 'billing.payment',
      aggregateId: PAYMENT,
      type: OutboxEventType.PAYMENT_CHANGED,
      payload: { userId: PAYER, paymentId: PAYMENT },
    });
  });
});

describe('settleOpen', () => {
  it('tries pending before expired, answers which matched, and announces it', async () => {
    const { tx, outbox, tried } = fakeTx({ paymentTenant: RESELLER, matches: [PaymentStatus.expired] });
    await expect(settleOpen(tx, PAYMENT, { status: PaymentStatus.failed })).resolves.toBe(PaymentStatus.expired);
    expect(tried).toEqual([PaymentStatus.pending, PaymentStatus.expired]);
    expect(outbox).toHaveLength(4);
  });

  it('announces nothing when another path settled it first', async () => {
    const { tx, outbox } = fakeTx({ paymentTenant: RESELLER });
    await expect(settleOpen(tx, PAYMENT, { status: PaymentStatus.failed })).resolves.toBeNull();
    expect(outbox).toEqual([]);
  });
});
