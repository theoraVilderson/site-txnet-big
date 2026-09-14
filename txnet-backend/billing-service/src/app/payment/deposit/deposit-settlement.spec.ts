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
  committed: boolean;
};

function build({ lostTheFlip = false } = {}) {
  const calls: Calls = { writes: [], accruals: [], committed: false };

  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      updateMany: async () => {
        calls.writes.push('flip');
        return { count: lostTheFlip ? 0 : 1 };
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
      create: async () => {
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
  };
  const ledger = {
    credit: async () => {
      calls.writes.push('credit');
      return { balanceAfter: d('119.80') };
    },
  };

  const service = new DepositSettlementService(prisma as never, reservations as never, ledger as never);
  return { service, calls };
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

    expect(calls.writes).toEqual(['flip']);
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

  it('refuses admin_manual without the person, and a person on any other source', async () => {
    const { service } = build();
    const run = (source: ConfirmationSource, manual?: { adminId: string; reason: string; ip: string }) =>
      runWithTenant({ id: TENANT }, () => service.creditVerified(paymentRow(), { referenceId: 'R', cardPan: null }, source, manual));

    await expect(run(ConfirmationSource.admin_manual)).rejects.toThrow(/ManualConfirmation/);
    await expect(run(ConfirmationSource.webhook_auto, { adminId: USER, reason: 'x', ip: 'y' })).rejects.toThrow(/ManualConfirmation/);
  });
});
