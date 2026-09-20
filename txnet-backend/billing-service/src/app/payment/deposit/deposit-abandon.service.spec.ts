/**
 * Giving back an in-chat top-up the payer never went through with (F-093-q).
 *
 * What would break silently here, and nowhere else:
 *  - **a cancelled invoice sheet gives its coupon holds back at once**: the
 *    one-use code the payer applied works on the very next attempt, instead of
 *    answering `per_user_limit_reached` until `PAYMENT_PENDING_TTL_SEC`;
 *  - **an approved payment is never abandoned**: pre-checkout said yes, so the
 *    platform may already have the money — the verify ladder owns that row
 *    (F-092-x, ADR-0047 decision 2) and its holds stay;
 *  - **only the payer's own in-chat payment**: a payment id in a body must not
 *    close somebody else's, nor a bank payment whose browser is still out;
 *  - **the close is status-guarded**, like the callback's, so a credit landing
 *    between the read and the write keeps its coupon uses.
 */
import { Prisma } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { DepositAbandonService } from './deposit-abandon.service';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '66666666-6666-4666-8666-666666666666';
const GATEWAY = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const d = (v: string) => new Prisma.Decimal(v);

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    userId: USER,
    status: 'pending',
    gatewayId: null,
    tenantGatewayConfigId: GATEWAY,
    amountCredited: d('10.00'),
    feeApplied: d('0.00'),
    chargedAmountMinor: BigInt(770),
    exchangeRateSnapshot: d('76.923076923076923077'),
    gatewayTrackingCode: null,
    authorityCandidates: [],
    gatewayReferenceId: null,
    grantId: null,
    verifyAttempts: 0,
    nextVerifyAt: null,
    gateway: null,
    tenantGatewayConfig: { providerName: 'telegram_stars' },
    ...overrides,
  };
}

function build(row: ReturnType<typeof paymentRow> | null = paymentRow(), opts: { flipWins?: boolean } = {}) {
  const { flipWins = true } = opts;
  const calls = {
    reads: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    released: [] as Array<{ orderReferenceId: string; status: string }>,
  };
  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        calls.reads.push(where);
        return row && where['id'] === row.id && where['userId'] === row.userId ? row : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updates.push({ where, data });
        return { count: flipWins && row && row.status === where['status'] ? 1 : 0 };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const stars = { name: 'telegram_stars', settlement: 'in_chat', chatPlatform: 'telegram', chargeCurrency: 'XTR', chargeDecimals: 0 };
  const zarinpal = { name: 'zarinpal', settlement: 'return', chargeCurrency: 'IRR', chargeDecimals: 0 };
  const registry = {
    has: (name: string) => name === 'telegram_stars' || name === 'zarinpal',
    get: (name: string) => (name === 'telegram_stars' ? stars : zarinpal),
  };
  const reservations = {
    release: async (_tx: unknown, orderReferenceId: string, status: string) => {
      calls.released.push({ orderReferenceId, status });
      return 1;
    },
  };
  const service = new DepositAbandonService(prisma as never, registry as never, reservations as never);
  return { service, calls };
}

const run = (service: DepositAbandonService, userId = USER, paymentId = PAYMENT) =>
  runWithTenant({ id: TENANT }, () => service.abandon({ userId, paymentId }));

describe('DepositAbandonService', () => {
  it('closes the unpaid in-chat payment and gives its coupon holds back as cancelled', async () => {
    const { service, calls } = build();
    await expect(run(service)).resolves.toEqual({ status: 'closed' });

    // The payer is the gate's, never the body's: both are in the read.
    expect(calls.reads[0]).toMatchObject({ id: PAYMENT, userId: USER });
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].where).toMatchObject({ id: PAYMENT, status: 'pending', gatewayTrackingCode: null, nextVerifyAt: null });
    expect(calls.updates[0].data).toEqual({
      status: 'failed',
      failureCode: 'abandoned',
      expiresAt: null,
      nextVerifyAt: null,
    });
    // `cancelled`, not `expired`: nothing timed out — the payer closed the sheet.
    expect(calls.released).toEqual([{ orderReferenceId: PAYMENT, status: 'cancelled' }]);
  });

  it('refuses a payment pre-checkout already approved, and releases nothing', async () => {
    for (const row of [
      paymentRow({ gatewayTrackingCode: PAYMENT }),
      paymentRow({ nextVerifyAt: new Date(), verifyAttempts: 1 }),
    ]) {
      const { service, calls } = build(row);
      await expect(run(service)).resolves.toEqual({ status: 'not_abandonable' });
      expect(calls.updates).toEqual([]);
      expect(calls.released).toEqual([]);
    }
  });

  it('answers already_closed for a payment that is no longer pending, and touches nothing', async () => {
    for (const status of ['success', 'failed', 'expired']) {
      const { service, calls } = build(paymentRow({ status }));
      await expect(run(service)).resolves.toEqual({ status: 'already_closed' });
      expect(calls.updates).toEqual([]);
      expect(calls.released).toEqual([]);
    }
  });

  it('will not close a payment that is not this user’s, or one at a gateway the browser went to', async () => {
    const someoneElse = build(paymentRow({ userId: OTHER_USER }));
    await expect(run(someoneElse.service)).resolves.toEqual({ status: 'not_found' });
    expect(someoneElse.calls.released).toEqual([]);

    // A bank payment: the payer may be on the gateway's page right now, and the
    // expiry clock is the only thing allowed to give those holds back.
    const atABank = build(paymentRow({ tenantGatewayConfig: { providerName: 'zarinpal' } }));
    await expect(run(atABank.service)).resolves.toEqual({ status: 'not_found' });
    expect(atABank.calls.updates).toEqual([]);
    expect(atABank.calls.released).toEqual([]);
  });

  it('gives nothing back when the guarded flip loses a race with a credit', async () => {
    // The row was `pending` when read; the flip finds it is not any more.
    const { service, calls } = build(paymentRow(), { flipWins: false });
    await expect(run(service)).resolves.toEqual({ status: 'already_closed' });
    expect(calls.updates).toHaveLength(1);
    expect(calls.released).toEqual([]);
  });

  it('answers not_found for a payment nobody here has', async () => {
    const { service, calls } = build(null);
    await expect(run(service)).resolves.toEqual({ status: 'not_found' });
    expect(calls.released).toEqual([]);
  });
});
