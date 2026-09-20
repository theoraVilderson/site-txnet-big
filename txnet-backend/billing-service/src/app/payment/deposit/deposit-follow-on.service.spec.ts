/**
 * Money that arrives for an invoice already settled (F-104-s).
 *
 * One provider invoice can hold several payments — `nowpayments.provider.ts`
 * says so itself — so the payer who covers a short payment with a second
 * transfer, or pays the same invoice again in another coin, sends money against
 * a row that is already `success`. Until this row it reached
 * `deposit-webhook.service.ts`'s `if (!open) return;`: no credit, no log, no
 * flag, and the money sitting in the merchant account with nothing in the
 * platform pointing at it.
 *
 * What would break silently here, and nowhere else:
 *  - **a repeat of the same transfer never credits twice.** The provider
 *    retries its IPN; the reference it names is the guard, and the unique index
 *    on (gateway column, `gatewayTrackingCode`) is the guard under that;
 *  - **the follow-on is a payment of its own**, not a second settlement of the
 *    old row: one `payment_transaction` a ledger row, an event, an accrual and
 *    the history page already know how to read;
 *  - **it carries no coupon.** The discount was bought by the first payment;
 *    a follow-on credits what arrived net of the gateway's cut, nothing more;
 *  - **money that cannot be valued is flagged, never guessed at.**
 */
import { Prisma } from '@prisma/client';
import { TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import { DepositFollowOnService, followOnCredit } from './deposit-follow-on.service';
import type { PaymentRow } from './deposit-settlement';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const INVOICE = 'inv_0001';

function original(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT,
    userId: USER,
    status: 'success',
    gatewayId: GATEWAY,
    tenantGatewayConfigId: null,
    // 100.00 asked, a 5% gateway: 105.00 charged, of which 5.00 is its cut.
    amountCredited: new Prisma.Decimal('100.00'),
    feeApplied: new Prisma.Decimal('5.00'),
    chargedAmountMinor: BigInt(10500),
    exchangeRateSnapshot: new Prisma.Decimal('1'),
    gatewayTrackingCode: INVOICE,
    authorityCandidates: [],
    gatewayReferenceId: 'pay_first',
    grantId: null,
    billingTenantId: null,
    verifyAttempts: 0,
    nextVerifyAt: null,
    channel: 'panel',
    gateway: { providerName: 'nowpayments' },
    tenantGatewayConfig: null,
    ...overrides,
  } as PaymentRow;
}

type Setup = {
  row?: PaymentRow;
  /** A payment already carrying the arriving reference as its code. */
  taken?: boolean;
  /** The create loses the unique index to a racing delivery. */
  raceLost?: boolean;
  credits?: boolean;
};

function build(setup: Setup = {}) {
  const { row = original(), taken = false, raceLost = false, credits = true } = setup;
  const calls = {
    lookups: [] as Array<Record<string, unknown>>,
    created: [] as Array<Record<string, unknown>>,
    credited: [] as Array<{ id: string; referenceId: string; received?: unknown }>,
    logs: [] as Array<{ paymentTransactionId: string; actionTaken: string; notes: string | null }>,
  };
  let made: Record<string, unknown> | null = null;

  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where['gatewayTrackingCode'] && where['id'] === undefined) {
          calls.lookups.push(where);
          return taken ? { id: 'other' } : null;
        }
        return made && where['id'] === made['id'] ? made : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (raceLost) {
          throw Object.assign(new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: '5',
          }), {});
        }
        calls.created.push(data);
        made = { ...data, status: 'pending', authorityCandidates: [], verifyAttempts: 0, nextVerifyAt: null,
                 gateway: { providerName: 'nowpayments' }, tenantGatewayConfig: null };
        return { id: data['id'] };
      },
    },
    paymentReconciliationLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.logs.push(data as never);
        return { id: 'log' };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const settlement = {
    creditVerified: async (p: { id: string }, verified: { referenceId: string; received?: unknown }) => {
      calls.credited.push({ id: p.id, referenceId: verified.referenceId, ...(verified.received ? { received: verified.received } : {}) });
      return credits;
    },
  };

  const service = new DepositFollowOnService(prisma as never, prisma as never, settlement as never);
  const take = (arrival: { referenceId: string; received?: { amountMinor: bigint; currency: string; decimals: number } }) =>
    runWithTenant({ id: TENANT }, () => service.take(row, { chargeDecimals: 2, ...arrival }));
  return { take, calls, tenant: () => TENANT, ctx: TenantContext };
}

describe('followOnCredit — what the arriving money is worth', () => {
  it('takes the gateway’s cut in the proportion that arrived, as a short receipt does (F-104-r)', () => {
    // 105.00 charged of which 5.00 is the cut; 42.00 arrives -> 100.00 x 42/105.
    expect(followOnCredit(original(), BigInt(4200), 2)).toEqual({
      credited: new Prisma.Decimal('40.00'),
      fee: new Prisma.Decimal('2.00'),
    });
  });

  it('credits a second full payment net of the fee — never the coupon’s discount again', () => {
    const discounted = original({ amountCredited: new Prisma.Decimal('100.00'), feeApplied: new Prisma.Decimal('5.00') });

    // The first payment credited 100.00 for a 105.00 charge because a coupon
    // paid part of it. The second one buys no discount: 105.00 in, 5.00 cut.
    expect(followOnCredit(discounted, BigInt(10500), 2)).toEqual({
      credited: new Prisma.Decimal('100.00'),
      fee: new Prisma.Decimal('5.00'),
    });
  });

  it('values nothing without a usable rate', () => {
    expect(followOnCredit(original({ exchangeRateSnapshot: null }), BigInt(4200), 2)).toBeNull();
  });

  it('values nothing when the gateway’s cut swallowed the whole charge', () => {
    expect(followOnCredit(original({ feeApplied: new Prisma.Decimal('105.00') }), BigInt(4200), 2)).toBeNull();
  });

  it('values nothing when under a cent arrived', () => {
    expect(followOnCredit(original(), BigInt(1), 2)).toBeNull();
  });
});

describe('DepositFollowOnService.take', () => {
  it('writes a payment of its own for the money and credits it', async () => {
    const { take, calls } = build();

    expect(await take({ referenceId: 'pay_second', received: { amountMinor: BigInt(4200), currency: 'USD', decimals: 2 } })).toBe('credited');

    expect(calls.created).toHaveLength(1);
    const made = calls.created[0];
    expect(made).toMatchObject({
      userId: USER,
      gatewayId: GATEWAY,
      // The coin transfer's own id, not the invoice's: the unique index on
      // (gateway, code) is what makes a retried delivery harmless.
      gatewayTrackingCode: 'pay_second',
      chargedAmountMinor: BigInt(4200),
      amountRequested: new Prisma.Decimal('40.00'),
      amountCredited: new Prisma.Decimal('40.00'),
      feeApplied: new Prisma.Decimal('2.00'),
      status: 'pending',
    });
    // A row on the platform column is never also on the reseller one, and
    // the discount is the first payment's, not this money's.
    expect(made['tenantGatewayConfigId']).toBeUndefined();
    expect(made['discountApplied']).toBeUndefined();
    expect(calls.credited).toEqual([
      { id: made['id'], referenceId: 'pay_second', received: { amountMinor: BigInt(4200), currency: 'USD', decimals: 2 } },
    ]);
  });

  it('leaves the settled invoice a log row naming the payment it grew (F-104-s)', async () => {
    const { take, calls } = build();

    await take({ referenceId: 'pay_second', received: { amountMinor: BigInt(4200), currency: 'USD', decimals: 2 } });

    expect(calls.logs).toHaveLength(1);
    expect(calls.logs[0]).toMatchObject({ paymentTransactionId: PAYMENT, actionTaken: 'auto_confirmed' });
    expect(calls.logs[0].notes).toContain('pay_second');
  });

  it('does nothing for a redelivery of the transfer that settled the invoice', async () => {
    const { take, calls } = build();

    expect(await take({ referenceId: 'pay_first' })).toBe('duplicate');
    expect(calls.created).toEqual([]);
    expect(calls.logs).toEqual([]);
  });

  it('does nothing for a redelivery of a transfer already taken', async () => {
    const { take, calls } = build({ taken: true });

    expect(await take({ referenceId: 'pay_second' })).toBe('duplicate');
    expect(calls.lookups).toEqual([{ gatewayId: GATEWAY, gatewayTrackingCode: 'pay_second' }]);
    expect(calls.created).toEqual([]);
  });

  it('treats the unique index refusing the write as that same redelivery', async () => {
    const { take, calls } = build({ raceLost: true });

    expect(await take({ referenceId: 'pay_second' })).toBe('duplicate');
    expect(calls.credited).toEqual([]);
    expect(calls.logs).toEqual([]);
  });

  it('flags money it cannot value, and credits nothing', async () => {
    const { take, calls } = build({ row: original({ exchangeRateSnapshot: null }) });

    expect(await take({ referenceId: 'pay_second', received: { amountMinor: BigInt(4200), currency: 'USD', decimals: 2 } })).toBe('flagged');
    expect(calls.created).toEqual([]);
    expect(calls.credited).toEqual([]);
    expect(calls.logs[0]).toMatchObject({ paymentTransactionId: PAYMENT, actionTaken: 'flagged_mismatch' });
  });

  it('values a report-less arrival as the invoice’s own charge', async () => {
    const { take, calls } = build();

    expect(await take({ referenceId: 'pay_second' })).toBe('credited');

    expect(calls.created[0]).toMatchObject({
      chargedAmountMinor: BigInt(10500),
      amountCredited: new Prisma.Decimal('100.00'),
      feeApplied: new Prisma.Decimal('5.00'),
    });
    // Nothing was reported, so nothing is written as received.
    expect(calls.credited[0].received).toBeUndefined();
  });

  it('flags the arrival when the credit did not take', async () => {
    const { take, calls } = build({ credits: false });

    expect(await take({ referenceId: 'pay_second' })).toBe('flagged');
    expect(calls.logs[0]).toMatchObject({ actionTaken: 'flagged_mismatch' });
  });
});
