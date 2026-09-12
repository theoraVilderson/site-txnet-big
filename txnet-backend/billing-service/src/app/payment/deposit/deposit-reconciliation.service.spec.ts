/**
 * Asking the gateway about a payment nobody came back for (F-092-l).
 *
 * What would break silently here, and nowhere else:
 *  - **it never closes a payment and never reverses one** (invariant 9). The
 *    only write it makes to a `payment_transaction` is the credit a gateway
 *    confirmed, through F-092-j's guarded path; a bank saying `failed` or
 *    `reversed` is recorded and nothing else, because the clock (F-092-k) is
 *    what closes a row and an auto-reversal is the one thing this table can
 *    never take back;
 *  - a **mismatch is flagged, not settled**: the gateway took a different
 *    amount than the row was priced at, and crediting either figure would be
 *    this job inventing a price;
 *  - an answer the gateway could not give — a timeout, an unreadable merchant
 *    id — writes **no log row at all**, so the next run asks again. A row saying
 *    "checked, nothing to do" would retire the payment from every future sweep;
 *  - the credit goes through `DepositSettlementService`, so a payer arriving a
 *    second before this sweep still credits exactly once (ADR-0028, invariant 7).
 *
 * The guarded flip itself is `deposit-callback.service.spec.ts`'s, over the
 * same settlement service.
 */
import { ConfirmationSource, PaymentStatus, Prisma, ReconciliationAction } from '@prisma/client';
import { CredentialUnavailable, TenantContext } from '@txnet-backend/shared-core';

import { GatewayFailure } from '../gateway/payment-provider';
import { DepositReconciliationService } from './deposit-reconciliation.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const AUTHORITY = 'A0000000000000000000000000000001';

const d = (v: string) => new Prisma.Decimal(v);

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    userId: USER,
    status: PaymentStatus.expired,
    gatewayId: null,
    tenantGatewayConfigId: GATEWAY,
    amountCredited: d('19.80'),
    chargedAmountMinor: BigInt(19_800_000),
    gatewayTrackingCode: AUTHORITY,
    gatewayReferenceId: null,
    gateway: null,
    tenantGatewayConfig: { providerName: 'zarinpal' },
    ...overrides,
  };
}

type Calls = {
  scans: Array<Record<string, unknown>>;
  inquired: Array<{ authority: string; tenantInScope: string | null }>;
  verified: Array<{ authority: string; amountMinor: bigint }>;
  credited: Array<{ source: string; paymentId: string }>;
  logs: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
};

type Setup = {
  due?: Array<{ id: string; tenantId: string | null }>;
  row?: ReturnType<typeof paymentRow> | null;
  /** What `inquire` answers. */
  inquiry?: 'verified' | 'paid' | 'in_bank' | 'failed' | 'reversed';
  /** `inquire` throws this instead of answering. */
  inquiryFails?: Error;
  /** `verify` throws this instead of confirming. */
  verifyFails?: Error;
  /** The guarded flip matched nothing — something settled the payment first. */
  lostTheFlip?: boolean;
  /** The vault cannot hand out this gateway's merchant id. */
  credentialsFail?: Error;
};

function build(setup: Setup = {}) {
  const {
    due = [{ id: PAYMENT, tenantId: TENANT }],
    row = paymentRow(),
    inquiry = 'paid',
    inquiryFails,
    verifyFails,
    lostTheFlip = false,
    credentialsFail,
  } = setup;

  const calls: Calls = { scans: [], inquired: [], verified: [], credited: [], logs: [], updated: [] };
  const scoped = () => TenantContext.currentOrNull()?.id ?? null;

  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      findFirst: async () => row,
      updateMany: async (args: Record<string, unknown>) => {
        calls.updated.push(args);
        return { count: lostTheFlip ? 0 : 1 };
      },
    },
    paymentReconciliationLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.logs.push(data);
        return { id: 'log-1' };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };

  const crossTenant = {
    paymentTransaction: {
      findMany: async (args: Record<string, unknown>) => {
        calls.scans.push(args);
        return due;
      },
    },
  };

  const zarinpal = {
    name: 'zarinpal',
    chargeCurrency: 'IRR',
    chargeDecimals: 0,
    inquire: async ({ authority }: { authority: string }) => {
      calls.inquired.push({ authority, tenantInScope: scoped() });
      if (inquiryFails) throw inquiryFails;
      return { status: inquiry };
    },
    verify: async ({ authority, amountMinor }: { authority: string; amountMinor: bigint }) => {
      calls.verified.push({ authority, amountMinor });
      if (verifyFails) throw verifyFails;
      return { referenceId: '900900900', cardPan: '6037********1234', alreadyVerified: true };
    },
  };
  const registry = { has: () => true, get: () => zarinpal };
  const merchant = {
    credentialsFor: async () => {
      if (credentialsFail) throw credentialsFail;
      return { merchantId: 'merchant' };
    },
  };
  const settlement = {
    creditVerified: async (payment: { id: string }, _v: unknown, source: string) => {
      calls.credited.push({ source, paymentId: payment.id });
      return !lostTheFlip;
    },
  };
  const config = { get: (key: string) => (key === 'RECONCILIATION_BATCH_SIZE' ? 50 : 3600) };

  const service = new DepositReconciliationService(
    prisma as never,
    crossTenant as never,
    registry as never,
    merchant as never,
    settlement as never,
    config as never,
  );
  return { service, calls };
}

describe('DepositReconciliationService', () => {
  it('credits a paid payment through the shared guarded path, as reconciliation', async () => {
    const { service, calls } = build({ inquiry: 'paid' });

    const result = await service.reconcile();

    expect(calls.verified).toEqual([{ authority: AUTHORITY, amountMinor: BigInt(19_800_000) }]);
    expect(calls.credited).toEqual([{ source: ConfirmationSource.reconciliation_auto, paymentId: PAYMENT }]);
    expect(calls.logs[0]).toMatchObject({
      paymentTransactionId: PAYMENT,
      actionTaken: ReconciliationAction.auto_confirmed,
      gatewayReportedStatus: 'paid',
    });
    expect(result).toMatchObject({ scanned: 1, confirmed: 1, flagged: 0, errors: 0 });
  });

  it('verifies an already-verified payment too, because that is where the reference number is', async () => {
    const { service, calls } = build({ inquiry: 'verified' });

    await service.reconcile();

    expect(calls.verified).toHaveLength(1);
    expect(calls.credited).toHaveLength(1);
  });

  it('flags an amount mismatch and settles nothing', async () => {
    const { service, calls } = build({
      inquiry: 'paid',
      verifyFails: new GatewayFailure('zarinpal', 'amount_mismatch', '-53', 'verified 1 rial'),
    });

    const result = await service.reconcile();

    expect(calls.credited).toEqual([]);
    expect(calls.updated).toEqual([]);
    expect(calls.logs[0]).toMatchObject({ actionTaken: ReconciliationAction.flagged_mismatch });
    expect(result).toMatchObject({ confirmed: 0, flagged: 1 });
  });

  it('never closes a payment the gateway says failed — it records and moves on', async () => {
    const { service, calls } = build({ inquiry: 'failed' });

    const result = await service.reconcile();

    expect(calls.verified).toEqual([]);
    expect(calls.credited).toEqual([]);
    expect(calls.updated).toEqual([]);
    expect(calls.logs[0]).toMatchObject({
      actionTaken: ReconciliationAction.no_action_needed,
      gatewayReportedStatus: 'failed',
    });
    expect(result).toMatchObject({ confirmed: 0, flagged: 0, unchanged: 1 });
  });

  it('never reverses a payment the gateway says was reversed', async () => {
    const { service, calls } = build({ inquiry: 'reversed' });

    await service.reconcile();

    expect(calls.updated).toEqual([]);
    expect(calls.logs[0]).toMatchObject({ actionTaken: ReconciliationAction.no_action_needed });
  });

  it('leaves a payment still in the bank alone', async () => {
    const { service, calls } = build({ inquiry: 'in_bank' });

    const result = await service.reconcile();

    expect(calls.verified).toEqual([]);
    expect(calls.logs[0]).toMatchObject({ gatewayReportedStatus: 'in_bank' });
    expect(result).toMatchObject({ unchanged: 1 });
  });

  it('writes no log row when the gateway did not answer, so the next run asks again', async () => {
    const { service, calls } = build({
      inquiryFails: new GatewayFailure('zarinpal', 'unavailable', null, 'timed out'),
    });

    const result = await service.reconcile();

    expect(calls.logs).toEqual([]);
    expect(result).toMatchObject({ scanned: 1, confirmed: 0, errors: 1 });
  });

  it('writes no log row when the merchant id cannot be read', async () => {
    const { service, calls } = build({
      credentialsFail: new CredentialUnavailable(
        { tenantId: TENANT, kind: 'gateway_merchant_id', label: `gateway:tenant:${GATEWAY}` } as never,
        'missing',
      ),
    });

    const result = await service.reconcile();

    expect(calls.inquired).toEqual([]);
    expect(calls.logs).toEqual([]);
    expect(result).toMatchObject({ errors: 1 });
  });

  it('records an authority the gateway does not know, so it is not asked about for ever', async () => {
    const { service, calls } = build({
      inquiryFails: new GatewayFailure('zarinpal', 'authority_invalid', '-53', 'unknown authority'),
    });

    const result = await service.reconcile();

    expect(calls.logs[0]).toMatchObject({ actionTaken: ReconciliationAction.no_action_needed });
    expect(result).toMatchObject({ unchanged: 1, errors: 0 });
  });

  it('counts a payment another path settled first as unchanged, not as a credit', async () => {
    const { service, calls } = build({ inquiry: 'paid', lostTheFlip: true });

    const result = await service.reconcile();

    expect(calls.credited).toHaveLength(1);
    expect(calls.logs[0]).toMatchObject({ actionTaken: ReconciliationAction.no_action_needed });
    expect(result).toMatchObject({ confirmed: 0, unchanged: 1 });
  });

  it('asks only about payments past their clock that carry an authority', async () => {
    const { service, calls } = build({ due: [] });

    await service.reconcile();

    const where = calls.scans[0]['where'] as Record<string, unknown>;
    expect(where['gatewayTrackingCode']).toEqual({ not: null });
    expect(JSON.stringify(where)).toContain(PaymentStatus.expired);
    expect(calls.scans[0]['take']).toBe(50);
  });

  it('inquires inside the payment owner tenant scope', async () => {
    const { service, calls } = build();

    await service.reconcile();

    expect(calls.inquired[0].tenantInScope).toBe(TENANT);
  });
});
