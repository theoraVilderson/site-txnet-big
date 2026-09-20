/**
 * What a settled payment writes, and in which transaction (F-092-j, F-096-d).
 *
 * The flip, the credit and the coupon confirm are covered where they are
 * reached from — `deposit-callback.service.spec.ts` runs this class for real.
 * What is only visible here is the debt a **granted** gateway accrues, and the
 * three ways it could be wrong without anything going red:
 *
 *  - accruing for a payment on a gateway the tenant owns. Nobody is owed
 *    anything: the money landed in this tenant's own merchant account;
 *  - accruing **outside** the crediting transaction, or after it. A wallet that
 *    grew without the debt being recorded is a tenant owed money that nothing
 *    knows about, and no later sweep can reconstruct it;
 *  - accruing on a call that lost the status guard. A retried callback and a
 *    reconciliation sweep both reach this code, and the platform would owe the
 *    same money twice — the unique key would stop it, but as an error on a
 *    payment rather than a rule.
 *
 * And the arithmetic: net of the gateway's own fee, which the payer covered and
 * the gateway kept, floored at zero rather than turning into a debt the other
 * way round.
 */
import { ConfirmationSource, PaymentStatus, Prisma } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { DepositSettlementService, PaymentRow } from './deposit-settlement';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const GRANT = 'aaaaaaaa-0000-4000-8000-000000000001';

const d = (v: string) => new Prisma.Decimal(v);

function paymentRow(overrides: Partial<Record<keyof PaymentRow, unknown>> = {}) {
  return {
    id: PAYMENT,
    userId: USER,
    status: PaymentStatus.pending,
    gatewayId: null,
    tenantGatewayConfigId: GATEWAY,
    amountCredited: d('19.80'),
    feeApplied: d('0.20'),
    chargedAmountMinor: BigInt(19_800_000),
    gatewayTrackingCode: 'A1',
    gatewayReferenceId: null,
    grantId: null,
    gateway: null,
    tenantGatewayConfig: { providerName: 'zarinpal' },
    ...overrides,
  } as unknown as PaymentRow;
}

type Calls = {
  /** Everything written, in order, so "inside the transaction" is checkable. */
  writes: string[];
  accruals: Array<Record<string, unknown>>;
  flips: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  credits: Array<Record<string, unknown>>;
  committed: boolean;
};

function build({ lostTheFlip = false, rowIs = PaymentStatus.pending as PaymentStatus } = {}) {
  const calls: Calls = { writes: [], accruals: [], flips: [], events: [], credits: [], committed: false };

  const tx = {
    $executeRaw: async () => 0,
    // The row lock `releaseFailedHolds` takes: found only while the row is still open.
    $queryRaw: async () => {
      calls.writes.push('lock');
      return rowIs === PaymentStatus.pending || rowIs === PaymentStatus.expired ? [{ locked: 1 }] : [];
    },
    paymentTransaction: {
      // The row really is `rowIs`: a guard naming another status matches nothing.
      updateMany: async ({ where, data }: { where: { status: PaymentStatus }; data: Record<string, unknown> }) => {
        const matched = !lostTheFlip && where.status === rowIs;
        if (matched) calls.flips.push({ where, data });
        calls.writes.push(matched ? 'flip' : `miss:${where.status}`);
        return { count: matched ? 1 : 0 };
      },
    },
    gatewaySettlementEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.writes.push('accrual');
        calls.accruals.push(data);
        return { id: 'entry-1' };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.events.push(data);
        calls.writes.push('event');
        return { id: 'event-1' };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.writes.push('audit');
        calls.accruals.push(data);
        return { id: 'audit-1' };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const out = await fn(tx);
      // Only reached if the body resolved: an accrual recorded after this is an
      // accrual outside the transaction.
      calls.committed = true;
      return out;
    },
  };

  const reservations = {
    confirm: async () => {
      calls.writes.push('confirm');
      return 1;
    },
    release: async (_tx: unknown, _order: string, outcome: string) => {
      calls.writes.push(`release:${outcome}`);
      return 1;
    },
    claimExpired: async () => {
      calls.writes.push('claim-expired');
      return 1;
    },
  };
  const ledger = {
    credit: async (_tx: unknown, entry: Record<string, unknown>) => {
      calls.writes.push('credit');
      calls.credits.push(entry);
      return { balanceAfter: d('119.80') };
    },
  };

  const service = new DepositSettlementService(prisma as never, reservations as never, ledger as never, {} as never, {} as never);
  return { service, calls, tx };
}

const settle = (service: DepositSettlementService, payment: PaymentRow) =>
  runWithTenant({ id: TENANT }, () =>
    service.creditVerified(
      payment,
      { referenceId: '900900900', cardPan: null },
      ConfirmationSource.webhook_auto,
    ),
  );

describe('DepositSettlementService — the debt a granted gateway leaves', () => {
  it('accrues the credited amount net of the gateway fee, to the borrowing tenant', async () => {
    const { service, calls } = build();

    await settle(service, paymentRow({ grantId: GRANT }));

    expect(calls.accruals).toEqual([
      {
        grantId: GRANT,
        tenantId: TENANT,
        paymentTransactionId: PAYMENT,
        // 19.80 credited, 0.20 of it the gateway's own cut.
        amount: d('19.60'),
      },
    ]);
  });

  it('writes it inside the crediting transaction, beside the ledger row', async () => {
    const { service, calls } = build();

    await settle(service, paymentRow({ grantId: GRANT }));

    expect(calls.writes).toEqual(['flip', 'credit', 'confirm', 'accrual', 'event']);
    expect(calls.committed).toBe(true);
  });

  it('accrues nothing for a gateway the tenant owns', async () => {
    const { service, calls } = build();

    await settle(service, paymentRow({ grantId: null }));

    expect(calls.accruals).toEqual([]);
    expect(calls.writes).toEqual(['flip', 'credit', 'confirm', 'event']);
  });

  it('accrues nothing on a call that lost the status guard', async () => {
    const { service, calls } = build({ lostTheFlip: true });

    await expect(settle(service, paymentRow({ grantId: GRANT }))).resolves.toBe(false);

    expect(calls.writes).toEqual(['miss:pending', 'miss:expired']);
  });

  it('floors a fee larger than the credit at zero, rather than owing backwards', async () => {
    const { service, calls } = build();

    await settle(service, paymentRow({ grantId: GRANT, amountCredited: d('1.00'), feeApplied: d('1.50') }));

    expect(calls.accruals[0]).toMatchObject({ amount: d('0') });
  });

  it('writes a person’s credit with its audit row in the same transaction (F-092-z)', async () => {
    const { service, calls } = build();

    await runWithTenant({ id: TENANT }, () =>
      service.creditVerified(paymentRow({ verifyAttempts: 3 }), { referenceId: 'R-1', cardPan: null }, ConfirmationSource.admin_manual, {
        adminId: USER,
        reason: 'checked the gateway panel',
        ip: '10.0.0.9',
      }),
    );

    expect(calls.writes).toEqual(['flip', 'credit', 'confirm', 'event', 'audit']);
    expect(calls.accruals[0]).toMatchObject({
      tenantId: TENANT,
      action: 'payment_manual_confirm',
      targetEntityId: PAYMENT,
      newValue: { gatewayReferenceId: 'R-1', reason: 'checked the gateway panel' },
    });
  });

  describe('a payment the gateway confirms after its clock ran out (F-092-aa, ADR-0046 decision 1)', () => {
    it('credits an expired payment: confirms the holds it still keeps, and claims back any the clock released', async () => {
      const { service, calls } = build({ rowIs: PaymentStatus.expired });

      // Read `pending` a moment ago; the expiry sweep flipped it since. The
      // guard, not the read, decides which coupon path runs. Since F-092-ah an
      // expired row usually still holds its coupons, and releases them only
      // COUPON_HOLD_AFTER_EXPIRY_SEC later — so both run; each moves only its own.
      await expect(settle(service, paymentRow({ status: PaymentStatus.pending }))).resolves.toBe(true);

      expect(calls.writes).toEqual(['miss:pending', 'flip', 'credit', 'confirm', 'claim-expired', 'event']);
    });

    it('confirms the holds of a payment still pending, and never claims', async () => {
      const { service, calls } = build({ rowIs: PaymentStatus.pending });

      await settle(service, paymentRow({ status: PaymentStatus.expired }));

      expect(calls.writes).toEqual(['flip', 'credit', 'confirm', 'event']);
    });
  });

  describe('a payment that arrived for another amount than asked (F-104-d, D-32)', () => {
    // 20 000 000 rials asked at 1 000 000 per dollar: 19.80 credited + 0.20 fee.
    const asked = () =>
      paymentRow({ amountCredited: d('19.80'), feeApplied: d('0.20'), chargedAmountMinor: BigInt(20_000_000), exchangeRateSnapshot: d('1000000') });
    const settleReceived = (service: DepositSettlementService, payment: PaymentRow, amountMinor: bigint, decimals = 0) =>
      runWithTenant({ id: TENANT }, () =>
        service.creditVerified(
          payment,
          { referenceId: 'R-9', cardPan: null, received: { amountMinor, currency: 'IRR', decimals } },
          ConfirmationSource.webhook_auto,
        ),
      );

    it('credits what arrived at the frozen rate, net of the fee, when less came, and gives the coupon holds back', async () => {
      const { service, calls } = build();

      await expect(settleReceived(service, asked(), BigInt(10_000_000))).resolves.toBe(true);

      expect(calls.writes).toEqual(['flip', 'credit', 'release:cancelled', 'event']);
      // Half of the 20.00 charge arrived, and the gateway keeps its 0.20 of it
      // in proportion: 19.80 x 1/2 (F-104-r).
      expect(calls.credits[0]).toMatchObject({ amount: d('9.90') });
      expect(calls.flips[0]).toMatchObject({
        data: { status: PaymentStatus.success, amountCredited: d('9.90'), amountReceivedMinor: BigInt(10_000_000), receivedCurrency: 'IRR' },
      });
      expect(calls.events[0]).toMatchObject({
        payload: {
          amountCredited: '9.90',
          amountAsked: '19.80',
          chargedAmountMinor: '20000000',
          amountReceivedMinor: '10000000',
          receivedCurrency: 'IRR',
        },
      });
    });

    it('never credits a fraction of a cent that did not arrive', async () => {
      const { service, calls } = build();

      await settleReceived(service, asked(), BigInt(10_009_999));

      // 19.80 x 10009999/20000000 = 9.909899..., and the fraction is dropped.
      expect(calls.credits[0]).toMatchObject({ amount: d('9.90') });
    });

    it('credits the asked amount plus the surplus when more came, and the coupon stays used', async () => {
      const { service, calls } = build();

      await settleReceived(service, asked(), BigInt(21_000_000));

      expect(calls.writes).toEqual(['flip', 'credit', 'confirm', 'event']);
      expect(calls.credits[0]).toMatchObject({ amount: d('20.80') });
      expect(calls.events[0]).toMatchObject({ payload: { amountCredited: '20.80', amountAsked: '19.80', amountReceivedMinor: '21000000' } });
    });

    it('credits exactly what was asked when exactly that came, and still records the receipt', async () => {
      const { service, calls } = build();

      await settleReceived(service, asked(), BigInt(20_000_000));

      expect(calls.writes).toEqual(['flip', 'credit', 'confirm', 'event']);
      expect(calls.credits[0]).toMatchObject({ amount: d('19.80') });
      expect(calls.flips[0]).toMatchObject({ data: { amountReceivedMinor: BigInt(20_000_000), receivedCurrency: 'IRR' } });
    });

    it('reads the receipt in the currency’s own minor unit', async () => {
      const { service, calls } = build();
      const usd = paymentRow({ amountCredited: d('19.80'), feeApplied: d('0.20'), chargedAmountMinor: BigInt(2000), exchangeRateSnapshot: d('1') });

      await settleReceived(service, usd, BigInt(1234), 2);

      // 12.34 of the 20.00 charge, less the fee's share: 19.80 x 1234/2000.
      expect(calls.credits[0]).toMatchObject({ amount: d('12.21') });
    });

    it('closes a payment worth under a cent failed, crediting nothing', async () => {
      const { service, calls } = build();

      await expect(settleReceived(service, asked(), BigInt(9_999))).resolves.toBe(false);

      expect(calls.writes).toEqual(['flip', 'release:cancelled']);
      expect(calls.flips[0]).toMatchObject({ data: { status: PaymentStatus.failed, failureCode: 'nothing_received' } });
    });

    // The fee the payer covered is inside `chargedAmountMinor`, so valuing a
    // short receipt whole credited it too — one cent short of a 5% fee credited
    // 104.99 where paying in full credited 100.00 (F-104-r).
    describe('a short receipt never credits more than paying in full (F-104-r)', () => {
      // 100.00 asked at a 5% manual fee: 105.00 payable, charged in USD cents.
      const withFee = () =>
        paymentRow({
          amountCredited: d('100.00'),
          feeApplied: d('5.00'),
          chargedAmountMinor: BigInt(10_500),
          exchangeRateSnapshot: d('1'),
        });

      it('credits one cent short of the charge less than the full payment credits', async () => {
        const { service, calls } = build();

        await settleReceived(service, withFee(), BigInt(10_499), 2);

        // 104.99 of 105.00 arrived, and the gateway keeps its cut of it:
        // 100.00 x 10499/10500 = 99.990476..., floored.
        expect(calls.credits[0]).toMatchObject({ amount: d('99.99') });
      });

      it('takes the fee out in proportion to what arrived', async () => {
        const { service, calls } = build();

        await settleReceived(service, withFee(), BigInt(5_250), 2);

        expect(calls.credits[0]).toMatchObject({ amount: d('50.00') });
      });

      it('credits a short receipt on a gateway with no fee at the frozen rate, unchanged', async () => {
        const { service, calls } = build();
        const free = paymentRow({
          amountCredited: d('100.00'),
          feeApplied: d('0.00'),
          chargedAmountMinor: BigInt(10_000),
          exchangeRateSnapshot: d('1'),
        });

        await settleReceived(service, free, BigInt(9_900), 2);

        expect(calls.credits[0]).toMatchObject({ amount: d('99.00') });
      });

      it('closes a receipt whose share of the fee leaves nothing, rather than crediting it', async () => {
        const { service, calls } = build();
        // The whole charge is the fee: nothing of it is ever the payer's credit.
        const allFee = paymentRow({
          amountCredited: d('0.50'),
          feeApplied: d('10.00'),
          chargedAmountMinor: BigInt(1_000),
          exchangeRateSnapshot: d('1'),
        });

        await expect(settleReceived(service, allFee, BigInt(900), 2)).resolves.toBe(false);

        expect(calls.flips[0]).toMatchObject({ data: { status: PaymentStatus.failed, failureCode: 'nothing_received' } });
      });
    });
  });

  describe('closeReversed — the gateway returned the money (F-092-ae, ADR-0046 decision 5)', () => {
    const close = (service: DepositSettlementService, tx: unknown) =>
      runWithTenant({ id: TENANT }, () => service.closeReversed(tx as never, paymentRow()));

    it('closes a pending payment, gives its holds back cancelled, and announces it — all on the caller\'s transaction', async () => {
      const { service, calls, tx } = build({ rowIs: PaymentStatus.pending });

      await expect(close(service, tx)).resolves.toBe(true);

      expect(calls.writes).toEqual(['flip', 'release:cancelled', 'event']);
      expect(calls.flips[0]).toMatchObject({
        where: { id: PAYMENT, status: PaymentStatus.pending },
        data: { status: PaymentStatus.failed, failureCode: 'reversed', expiresAt: null, nextVerifyAt: null },
      });
      expect(calls.events[0]).toMatchObject({
        aggregate: 'billing.payment',
        aggregateId: PAYMENT,
        type: 'billing.payment.reversed',
        payload: { tenantId: TENANT, userId: USER, paymentId: PAYMENT, chargedAmountMinor: '19800000' },
      });
    });

    it('closes an expired one and gives back the holds it still keeps, cancelled (F-092-ah)', async () => {
      const { service, calls, tx } = build({ rowIs: PaymentStatus.expired });

      await expect(close(service, tx)).resolves.toBe(true);

      expect(calls.writes).toEqual(['miss:pending', 'flip', 'release:cancelled', 'event']);
    });

    it('does nothing to a payment already settled, and announces nothing', async () => {
      const { service, calls, tx } = build({ rowIs: PaymentStatus.success });

      await expect(close(service, tx)).resolves.toBe(false);

      expect(calls.writes).toEqual(['miss:pending', 'miss:expired']);
    });
  });

  describe('closeFailed — the gateway says the payment failed (F-092-aj, ADR-0047 decision 4)', () => {
    const close = (service: DepositSettlementService, tx: unknown) =>
      runWithTenant({ id: TENANT }, () => service.closeFailed(tx as never, paymentRow()));

    it('closes a pending payment failed, gives its holds back cancelled, and announces nothing', async () => {
      const { service, calls, tx } = build({ rowIs: PaymentStatus.pending });

      await expect(close(service, tx)).resolves.toBe(true);

      expect(calls.writes).toEqual(['flip', 'release:cancelled']);
      expect(calls.flips[0]).toMatchObject({
        where: { id: PAYMENT, status: PaymentStatus.pending },
        data: { status: PaymentStatus.failed, failureCode: 'payment_failed', expiresAt: null, nextVerifyAt: null },
      });
      expect(calls.events).toEqual([]);
    });

    it('closes an expired one the same way', async () => {
      const { service, calls, tx } = build({ rowIs: PaymentStatus.expired });

      await expect(close(service, tx)).resolves.toBe(true);

      expect(calls.writes).toEqual(['miss:pending', 'flip', 'release:cancelled']);
    });

    it('does nothing to a payment already settled', async () => {
      const { service, calls, tx } = build({ rowIs: PaymentStatus.success });

      await expect(close(service, tx)).resolves.toBe(false);

      expect(calls.writes).toEqual(['miss:pending', 'miss:expired']);
    });
  });

  describe('rejectManually — a person ends an open payment nobody paid (F-092-ak)', () => {
    const MANUAL = { adminId: USER, reason: 'The payer never paid and asked for the coupon back', ip: '10.0.0.9' };
    const reject = (service: DepositSettlementService) =>
      runWithTenant({ id: TENANT }, () => service.rejectManually(paymentRow(), MANUAL));

    it('closes it failed / rejected_manually, gives the holds back, and writes the audit row in the same transaction', async () => {
      const { service, calls } = build({ rowIs: PaymentStatus.expired });

      await expect(reject(service)).resolves.toBe(true);

      expect(calls.writes).toEqual(['miss:pending', 'flip', 'release:cancelled', 'audit']);
      expect(calls.flips[0]).toMatchObject({
        data: { status: PaymentStatus.failed, failureCode: 'rejected_manually', expiresAt: null, nextVerifyAt: null },
      });
      expect(calls.accruals[0]).toMatchObject({
        tenantId: TENANT,
        adminId: USER,
        action: 'payment_manual_reject',
        targetEntityType: 'payment',
        targetEntityId: PAYMENT,
        oldValue: { status: PaymentStatus.expired },
        newValue: { status: PaymentStatus.failed, failureCode: 'rejected_manually', reason: MANUAL.reason },
        adminIpAddress: '10.0.0.9',
      });
      expect(calls.events).toEqual([]);
      expect(calls.committed).toBe(true);
    });

    it('writes nothing, and no audit row, when another path settled it first', async () => {
      const { service, calls } = build({ rowIs: PaymentStatus.success });

      await expect(reject(service)).resolves.toBe(false);

      expect(calls.writes).toEqual(['miss:pending', 'miss:expired']);
    });
  });

  it('refuses admin_manual without the person, and a person on any other source', async () => {
    const { service } = build();
    const run = (source: ConfirmationSource, manual?: { adminId: string; reason: string; ip: string }) =>
      runWithTenant({ id: TENANT }, () => service.creditVerified(paymentRow(), { referenceId: 'R', cardPan: null }, source, manual));

    await expect(run(ConfirmationSource.admin_manual)).rejects.toThrow(/ManualConfirmation/);
    await expect(run(ConfirmationSource.webhook_auto, { adminId: USER, reason: 'x', ip: 'y' })).rejects.toThrow(/ManualConfirmation/);
  });
});
